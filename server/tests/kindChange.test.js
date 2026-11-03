/**
 * kindChange.test.js — 결정 332: 접수된 리뷰↔블로그 오더의 체험단 종류 바꾸기 = 손대지 않은 빈 작업이면 접수 되돌리기.
 *   [1] deleteTask 예외 두 가지(자기 오더 연결 · 게시한 적 없는 임시저장 공고)는 종류 변경이 부를 때만 열린다(기본값 = 결정 254 그대로)
 *   [2] 오더 되돌리기(beforeCommit)가 실패하면 작업표 삭제까지 통째로 되돌린다(COMMIT 없음)
 *   [3] 오더 수정 경로 — 번호 +1 요청만 · 리뷰↔블로그만 · 판정 실패 = 못 바꿈 · 수정 창 판정을 응답에 싣는다
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

const svc = require('../src/services/workTabDelete.service');

const mkPool = (hits = {}) => {
  const log = [], params = [];
  const client = {
    async query(sql, p) {
      const q = sql.replace(/\s+/g, ' ').trim();
      log.push(q); params.push([q, p]);
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(q) || /pg_advisory_xact_lock/.test(q)) return { rows: [] };
      if (/SELECT COALESCE\(sheetless, FALSE\) AS sl FROM tab_configs/.test(q)) return { rows: [{ sl: true }] };
      if (/^SELECT EXISTS \(SELECT 1 FROM (\w+) WHERE sheet_id=\$1 AND tab_name=\$2\) AS x/.test(q)) return { rows: [{ x: false }] };
      if (/AS live,/.test(q) && /^SELECT/.test(q)) return { rows: [{ live: 0, used: 0 }] };
      if (/FROM work_orders w WHERE w\.deleted_at IS NULL AND w\.linked_tab_sheet_id=\$1/.test(q)) return { rows: [{ x: false }] };
      if (/^SELECT EXISTS/.test(q)) return { rows: [{ x: false }] };
      if (/^UPDATE work_orders SET linked_tab_sheet_id=''/.test(q)) return { rows: [{ id: 'wo_self', title: 't', status: 'reviewing', created_by: 'x', live: true }], rowCount: 1 };
      if (/^DELETE FROM campaign_participants/.test(q)) return { rows: [{ f: false }], rowCount: 1 };
      if (/^DELETE FROM recruit_campaigns/.test(q)) return { rows: [{ draft: !!hits.draft, live: true }], rowCount: 1 };
      if (/^DELETE|^UPDATE|^INSERT/.test(q)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
    release() {},
  };
  return { log, params, pool: { async connect() { return client; }, async query(s, p) { return client.query(s, p); } } };
};
const quietMemo = async (fn) => {
  const memo = require('../src/services/intranetMemo.service');
  const a = memo.pushIntranetMemo, b = memo.appendMemoLog;
  memo.pushIntranetMemo = async () => ({ delivered: false }); memo.appendMemoLog = async () => true;
  try { return await fn(); } finally { memo.pushIntranetMemo = a; memo.appendMemoLog = b; }
};

(async () => {
  console.log('[1] deleteTask 예외는 종류 변경만');
  await ok('예외 없이(결정 254 기본값) 자기 오더·임시저장 공고가 지운 결과에 있으면 되돌린다', () => quietMemo(async () => {
    const { log, pool } = mkPool({ draft: true });
    const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, notifyIntranet: false, pool });
    assert.strictEqual(out.ok, false); assert.ok(log.includes('ROLLBACK') && !log.includes('COMMIT'));
  }));
  await ok('종류 변경 예외 — 자기 오더 연결 + 게시한 적 없는 임시저장 공고면 지운다(COMMIT)', () => quietMemo(async () => {
    const { log, params, pool } = mkPool({ draft: true });
    let called = 0;
    const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, notifyIntranet: false, pool,
      untouched: { selfOrderId: 'wo_self', allowDraftCampaign: true }, beforeCommit: async () => { called++; return { ok: true }; } });
    assert.strictEqual(out.ok, true, JSON.stringify(out)); assert.strictEqual(called, 1); assert.ok(log.includes('COMMIT'));
    const wo = params.find(([q]) => /FROM work_orders w WHERE w\.deleted_at IS NULL AND w\.linked_tab_sheet_id=\$1/.test(q));
    assert.deepStrictEqual(wo[1], ['s', 't', 'wo_self'], '판정도 자기 오더를 뺀다');
    const rc = params.find(([q]) => /AS live,/.test(q) && /^SELECT/.test(q));
    assert.strictEqual(rc[1][2], true, '판정도 임시저장 공고를 뺀다');
  }));
  await ok('게시한 적 있는 공고(임시저장 아님)는 종류 변경이라도 되돌린다', () => quietMemo(async () => {
    const { log, pool } = mkPool({ draft: false });
    const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, notifyIntranet: false, pool,
      untouched: { selfOrderId: 'wo_self', allowDraftCampaign: true }, beforeCommit: async () => ({ ok: true }) });
    assert.strictEqual(out.ok, false); assert.ok(out.reasons.includes('live_campaign')); assert.ok(!log.includes('COMMIT'));
  }));
  await ok('다른 오더가 지운 결과에 있으면 종류 변경이라도 되돌린다', () => quietMemo(async () => {
    const { log, pool } = mkPool({ draft: true });
    const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, notifyIntranet: false, pool,
      untouched: { selfOrderId: 'wo_other', allowDraftCampaign: true }, beforeCommit: async () => ({ ok: true }) });
    assert.strictEqual(out.ok, false); assert.ok(out.reasons.includes('live_work_order')); assert.ok(!log.includes('COMMIT'));
  }));
  await ok('예외·마무리 훅은 onlyIfUntouched 없이 쓸 수 없다(사람 확인 없는 경로는 판정을 반드시 탄다)', async () => {
    const { pool } = mkPool({});
    await assert.rejects(() => svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, pool, beforeCommit: async () => ({ ok: true }) }));
    await assert.rejects(() => svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, pool, untouched: { selfOrderId: 'x' } }));
  });

  console.log('[2] 오더 되돌리기 실패 = 통째로 되돌림');
  await ok('beforeCommit 이 실패하면 ROLLBACK · COMMIT 없음 · 사유를 돌려준다', () => quietMemo(async () => {
    const { log, pool } = mkPool({ draft: true });
    const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, notifyIntranet: false, pool,
      untouched: { selfOrderId: 'wo_self', allowDraftCampaign: true }, beforeCommit: async () => ({ ok: false, code: 'revision_moved' }) });
    assert.strictEqual(out.ok, false); assert.deepStrictEqual(out.reasons, ['revision_moved']);
    assert.ok(log.includes('ROLLBACK') && !log.includes('COMMIT'));
  }));

  console.log('[3] 오더 수정 경로');
  const src = read('server/src/routes/order.routes.js');
  const branch = src.slice(src.indexOf('결정 332 — 접수된 리뷰↔블로그 오더의 종류 바꾸기 = 손대지 않은'), src.indexOf('★★ Q&A체험단(결정 321) — 자리표가 깔린 오더는 발행 전이라도 작업표 칸'));
  await ok('종류 변경 분기는 Q&A 잠금·종전 종류 잠금보다 앞에 있다', () => {
    assert.ok(branch.length > 200, '분기를 찾지 못함');
    assert.ok(src.indexOf(branch) < src.indexOf("code: 'accepted_kind_locked'"));
  });
  await ok('번호가 정확히 +1 인 요청만 작업표를 지운다(낡은·중복 요청 금지)', () => {
    assert.ok(/source\.sourceRevision === Number\(current\.source_revision \|\| 0\) \+ 1/.test(branch));
  });
  await ok('결정 254 판정을 그대로 탄다(onlyIfUntouched) · 인트라넷 푸시 없음 · 예외는 자기 오더·임시저장 공고뿐', () => {
    assert.ok(/onlyIfUntouched: true/.test(branch) && /notifyIntranet: false/.test(branch));
    assert.ok(/untouched: \{ selfOrderId: current\.id, allowDraftCampaign: true \}/.test(branch));
  });
  await ok('오더 되돌리기는 같은 트랜잭션 · 읽은 번호 그대로일 때만', () => {
    assert.ok(/beforeCommit: async \(client\) =>/.test(branch));
    assert.ok(/WHERE id = \$1 AND COALESCE\(source_revision, 0\) = \$2 AND deleted_at IS NULL/.test(branch));
    assert.ok(/status = 'submitted', linked_campaign_id = '', bidir_state = 'off', advertiser_id = ''/.test(branch));
  });
  await ok('리뷰↔블로그만(Q&A 제외) · 게시·완료 오더 제외', () => {
    assert.ok(/const KIND_CHANGE_KINDS = new Set\(\['review', 'blog'\]\)/.test(src));
    assert.ok(/const KIND_CHANGE_STATUSES = new Set\(\['reviewing', 'revision', 'rejected', 'await_chatroom'\]\)/.test(src));
  });
  await ok('판정 실패 = 못 바꿈(fail-closed) · 수정 창 판정을 공유 조회 응답에 싣는다', () => {
    assert.ok(/reasons: \['check_failed'\]/.test(src));
    assert.ok(/kind_change: await kindChangeVerdict\(rows\[0\]\)/.test(src));
  });

  console.log(`\nkindChange: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
