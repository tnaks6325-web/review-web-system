'use strict';

/**
 * 확정 중복 자동처리 회귀가드.
 * - 해시만 같은 파일, 미완료 업로드, 같은 행, 같은 리뷰어의 다른 작업은 후보에서 제외
 * - 실행 직전 DB 행 잠금 + 보존본/제거본 Drive 상태 재검증
 * - 나중 제출본만 휴지통, 대표 재계산과 불량 종결을 같은 DB 트랜잭션에서 처리
 * - DB 실패 시 Drive 휴지통 이동 보상 복구
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/reviewDuplicateAuto.service');

let n = 0;
const ok = name => { n++; console.log('  ✓ ' + name); };
const root = path.join(__dirname, '..');

const candidate = (extra = {}) => ({
  file_id: 'NEW', file_name: 'new.png', sheet_id: 'S', tab_name: 'T', row_index: 8,
  reviewer_name: '새리뷰어', file_hash: 'HASH', uploaded_at: '2026-09-02T00:00:00Z',
  completion_order_at: '2026-09-04T00:00:00Z',
  match_file_id: 'KEEP', match_file_name: 'keep.png', match_sheet_id: 'S',
  match_tab_name: 'T', match_row_index: 7, match_reviewer_name: '기존리뷰어',
  match_uploaded_at: '2026-09-01T00:00:00Z', total_count: '2',
  match_completion_order_at: '2026-09-03T00:00:00Z',
  ...extra,
});

function txPool(handler) {
  const calls = [];
  const client = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return handler(String(sql), params, calls);
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { connect: async () => client, client };
}

(async () => {
  console.log('\nA) 후보 미리보기');
  {
    let query = null;
    const pool = { query: async (sql, params) => {
      query = { sql: String(sql), params };
      return { rows: [candidate()] };
    } };
    svc.__setDepsForTest({ pool });
    const out = await svc.autoResolveConfirmedDuplicates({ dryRun: true });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.total, 2);
    assert.deepStrictEqual(out.pairs, [{ fileId: 'NEW', matchFileId: 'KEEP' }]);
    assert.strictEqual(out.truncated, true);
    assert.ok(/checks->'duplicate'->>'verdict' = 'fail'/.test(query.sql));
    assert.ok(/s\.file_hash IS NOT NULL AND s\.file_hash = k\.file_hash/.test(query.sql));
    assert.ok(/CASE WHEN s\.upload_batch_id IS NULL THEN s\.uploaded_at ELSE s\.completed_at END/.test(query.sql));
    assert.ok(/CASE WHEN k\.upload_batch_id IS NULL THEN k\.uploaded_at ELSE k\.completed_at END/.test(query.sql));
    assert.ok(/ELSE s\.completed_at END\s*>\s*CASE WHEN k\.upload_batch_id/.test(query.sql),
      '신규 파일은 업로드 순서가 아니라 실제 제출 완료 순서로 제거본 결정');
    assert.ok(/NOT \(s\.sheet_id = k\.sheet_id AND s\.tab_name = k\.tab_name/.test(query.sql));
    assert.ok(/s\.completed_at IS NOT NULL OR s\.upload_batch_id IS NULL/.test(query.sql));
    assert.ok(/k\.completed_at IS NOT NULL OR k\.upload_batch_id IS NULL/.test(query.sql));
    assert.ok((query.sql.match(/is_submitted = TRUE/g) || []).length >= 4,
      '제거본·보존본 각각 review_index/campaign_participants 완료 상태 확인');
    assert.ok(/REPLACE\(s\.reviewer_name, ' ', ''\) <> REPLACE\(k\.reviewer_name, ' ', ''\)/.test(query.sql),
      '같은 리뷰어의 다른 작업 자동 제외');
    ok('완료 매핑·동일 해시·선후 관계·예외 조건을 모두 만족한 쌍만 미리보기');

    const scoped = await svc.listConfirmedDuplicates({ sheetId: 'S', tabName: 'T', limit: 10 });
    assert.deepStrictEqual(query.params, ['S', 'T', 10]);
    assert.ok(/s\.sheet_id = \$1 AND s\.tab_name = \$2/.test(query.sql));
    assert.strictEqual(scoped.ok, true);
    ok('선택 작업 범위를 서버 SQL에 적용');
  }

  console.log('\nB) 스냅샷·실행 재검증');
  {
    const pair = { fileId: 'NEW', matchFileId: 'KEEP' };
    const token = svc._snapshotToken([pair]);
    svc.__setDepsForTest({ pool: { query: async () => { throw new Error('호출되면 안 됨'); } } });
    const bad = await svc.autoResolveConfirmedDuplicates({
      dryRun: false, confirm: svc.CONFIRM, snapshotToken: 'wrong', pairs: [pair],
    });
    assert.strictEqual(bad.ok, false);
    assert.ok(/스냅샷/.test(bad.error));
    const noConfirm = await svc.autoResolveConfirmedDuplicates({
      dryRun: false, snapshotToken: token, pairs: [pair],
    });
    assert.strictEqual(noConfirm.ok, false);
    assert.ok(/확인값/.test(noConfirm.error));
    ok('미리보기 스냅샷과 명시 확인값 없이는 실행 차단');

    const pool = txPool(async sql => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT i\.file_id/.test(sql)) return { rows: [candidate()] };
      if (/UPDATE review_submissions/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE review_inspections/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error('unexpected query: ' + sql.slice(0, 80));
    });
    const driveCalls = [];
    const drive = {
      getFileParents: async fileId => { driveCalls.push(['get', fileId]); return { id: fileId, trashed: false, parents: ['P'] }; },
      trashFiles: async files => { driveCalls.push(['trash', files]); return { success: 1, failed: 0, errors: [] }; },
      restoreFiles: async files => { driveCalls.push(['restore', files]); return { success: 1, failed: 0, errors: [] }; },
    };
    const routeCalls = [];
    const fileRoute = {
      recomputePrimary: async args => { routeCalls.push(['primary', args]); return { ok: true }; },
      logRouteEvent: async args => { routeCalls.push(['log', args]); },
    };
    svc.__setDepsForTest({ pool, drive, fileRoute });
    const out = await svc.autoResolveConfirmedDuplicates({
      dryRun: false, confirm: svc.CONFIRM, snapshotToken: token, pairs: [pair], by: '관리자',
    });
    assert.strictEqual(out.processed, 1);
    assert.strictEqual(out.skipped, 0);
    assert.deepStrictEqual(driveCalls.slice(0, 2), [['get', 'KEEP'], ['get', 'NEW']]);
    assert.strictEqual(driveCalls[2][0], 'trash');
    const locked = pool.client.calls.find(c => /SELECT i\.file_id/.test(c.sql));
    assert.ok(/FOR UPDATE OF s, k/.test(locked.sql), '실행 직전 양쪽 원장 행 잠금');
    assert.deepStrictEqual(locked.params, ['NEW', 'KEEP']);
    const upd = pool.client.calls.find(c => /UPDATE review_submissions/.test(c.sql));
    assert.ok(/slot_key = 'trashed'/.test(upd.sql));
    assert.ok(/^dedup-auto:duplicate-auto-v1:/.test(upd.params[1]));
    assert.ok(routeCalls.find(c => c[0] === 'primary' && c[1].db === pool.client),
      '대표 이미지 재계산이 같은 DB 트랜잭션 사용');
    assert.ok(pool.client.calls.find(c => /resolution = 'bad'/.test(c.sql)));
    assert.ok(routeCalls.find(c => c[0] === 'log' && c[1].context.automatic === true));
    ok('Drive 양쪽 확인 후 나중 제출본만 휴지통·원장·대표·검수 상태 갱신');
  }

  console.log('\nC) 변경·실패 안전핀');
  {
    const pair = { fileId: 'NEW', matchFileId: 'KEEP' };
    const token = svc._snapshotToken([pair]);
    let trashCount = 0;
    let pool = txPool(async sql => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT i\.file_id/.test(sql)) return { rows: [] };
      throw new Error('unexpected');
    });
    svc.__setDepsForTest({
      pool,
      drive: { getFileParents: async () => { throw new Error('호출되면 안 됨'); }, trashFiles: async () => { trashCount++; } },
      fileRoute: {},
    });
    let out = await svc.autoResolveConfirmedDuplicates({
      dryRun: false, confirm: svc.CONFIRM, snapshotToken: token, pairs: [pair],
    });
    assert.strictEqual(out.processed, 0);
    assert.strictEqual(out.reasons.state_changed, 1);
    assert.strictEqual(trashCount, 0);
    ok('미리보기 뒤 완료·매핑 상태가 달라지면 Drive 호출 없이 제외');

    pool = txPool(async sql => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT i\.file_id/.test(sql)) return { rows: [candidate()] };
      throw new Error('unexpected');
    });
    svc.__setDepsForTest({
      pool,
      drive: {
        getFileParents: async id => ({ id, trashed: id === 'KEEP' }),
        trashFiles: async () => { trashCount++; return { success: 1, failed: 0 }; },
      },
      fileRoute: {},
    });
    out = await svc.autoResolveConfirmedDuplicates({
      dryRun: false, confirm: svc.CONFIRM, snapshotToken: token, pairs: [pair],
    });
    assert.strictEqual(out.processed, 0);
    assert.strictEqual(out.reasons.preserved_file_missing, 1);
    assert.strictEqual(trashCount, 0);
    ok('보존본이 Drive에 없거나 휴지통이면 제거본을 건드리지 않음');

    let restoreCount = 0;
    pool = txPool(async sql => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT i\.file_id/.test(sql)) return { rows: [candidate()] };
      if (/UPDATE review_submissions/.test(sql)) throw new Error('db write failed');
      throw new Error('unexpected');
    });
    svc.__setDepsForTest({
      pool,
      drive: {
        getFileParents: async id => ({ id, trashed: false }),
        trashFiles: async () => ({ success: 1, failed: 0 }),
        restoreFiles: async files => { restoreCount += files.length; return { success: 1, failed: 0 }; },
      },
      fileRoute: {},
    });
    out = await svc.autoResolveConfirmedDuplicates({
      dryRun: false, confirm: svc.CONFIRM, snapshotToken: token, pairs: [pair],
    });
    assert.strictEqual(out.processed, 0);
    assert.strictEqual(out.reasons.action_failed, 1);
    assert.strictEqual(restoreCount, 1);
    assert.ok(pool.client.calls.some(c => c.sql === 'ROLLBACK'));
    ok('Drive 이동 뒤 DB 실패 시 롤백하고 파일을 휴지통에서 복구');
  }

  console.log('\nD) API·화면 배선');
  {
    const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
    const front = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
    const drive = fs.readFileSync(path.join(root, 'src/services/drive.service.js'), 'utf8');
    assert.ok(/'\/review-inspect\/duplicates\/auto-resolve', authMiddleware, adminOrMasterMiddleware/.test(routes));
    assert.ok(/confirm: String\(b\.confirm \|\| ''\)/.test(routes));
    assert.ok(/snapshotToken: String\(b\.snapshotToken \|\| ''\)/.test(routes));
    assert.ok(/function riDuplicateAutoResolve\(\)/.test(front));
    assert.ok(/양쪽 제출 완료와 보존 파일/.test(front));
    assert.ok(/리뷰어에게 1:1 메시지는 자동 전송하지 않습니다/.test(front));
    assert.ok(/async function restoreFiles/.test(drive) && /restoreFiles,/.test(drive));
    ok('관리자 전용 API와 미리보기 확인 UI, Drive 보상 복구 배선');
  }

  svc.__setDepsForTest({});
  console.log(`\n✅ reviewDuplicateAuto 회귀가드 ${n}케이스 통과`);
})().catch(err => {
  console.error('\n❌ reviewDuplicateAuto 실패:', err.stack || err.message);
  svc.__setDepsForTest({});
  process.exit(1);
});
