/**
 * orderDeleteTabCleanup.test.js — 결정 254: 인트라넷에서 작업오더를 지우면 그 오더가 만든 **손대지 않은 빈 작업**을 함께 정리한다.
 * 발단(운영 2026-10-15): 「10/7 곰표한일 탄소매트 26건」·「10/14 라자가구 3단서랍장 7건」 — 오더를 지우고 날짜를 바꿔 다시 올리자
 *   빈 작업보드(0/26 · 0/7)가 남아 같은 작업이 두 개로 보였다. 인트라넷 삭제는 오더에 표시만 하고 작업표는 건드리지 않았다.
 *   [1] 사람이 손댄 작업으로 보는 표는 모두 DELETE_TABLES 안(빠지면 판정이 그 표를 못 본다)
 *   [2] deleteTask(onlyIfUntouched) — 잠근 뒤 같은 트랜잭션에서 판정 · 걸리면 쓰기 0 · 인트라넷 메모 푸시 없음(기록만)
 *   [3] 오더 삭제 응답 뒤에 정리(절대 throw 없음) · 스위치
 *   [4] 홈 목록 "원본 오더 삭제됨"(살아 있는 오더가 없을 때만 · 실패 = 주석 없음) · 화면 배선
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

const svc = require('../src/services/workTabDelete.service');

(async () => {
  console.log('[1] 손댄 작업 판정 표');
  await ok('UNTOUCHED_BLOCK_TABLES 는 전부 DELETE_TABLES 안', () => {
    for (const t of svc.UNTOUCHED_BLOCK_TABLES) assert.ok(svc.DELETE_TABLES.includes(t), t);
  });
  await ok('주문·편집·리뷰·메모·마감·정산 연결은 반드시 판정 대상', () => {
    for (const t of ['order_submissions', 'participant_edits', 'review_submissions', 'trackb_tab_memos', 'trackb_tab_threads', 'trackb_tab_finished', 'workdesk_participant_deletions'])
      assert.ok(svc.UNTOUCHED_BLOCK_TABLES.includes(t), t);
  });

  await ok('정산 계약 연결은 접수 자동 연결(자동(작업오더))은 빼고 사람이 연결한 것만 손댄 것으로 본다', () => {
    const s = read('server/src/services/workTabDelete.service.js');
    assert.ok(!svc.UNTOUCHED_BLOCK_TABLES.includes('trackb_settlement_links'));
    assert.ok(/const SETTLEMENT_AUTO_BY = '자동\(작업오더\)';/.test(s));
    assert.ok(/AND COALESCE\(linked_by,''\) <> \$3\) AS x`, \[sheetId, tabName, SETTLEMENT_AUTO_BY\]\);\s*if \(sl\[0\] && sl\[0\]\.x\) reasons\.push\('trackb_settlement_links'\);/.test(s));
    assert.ok(/'자동\(작업오더\)'\]\);/.test(read('server/src/routes/order.routes.js')), '접수 자동 연결 표기가 같다');
  });

  console.log('[2] deleteTask(onlyIfUntouched) — 스텁 pool 로 실제 실행');
  const mkPool = (hits = {}) => {
    const log = [];
    const client = {
      async query(sql, params) {
        log.push(sql.replace(/\s+/g, ' ').trim());
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
        if (/SELECT COALESCE\(sheetless, FALSE\) AS sl FROM tab_configs/.test(sql)) return { rows: hits.notRegistered ? [] : [{ sl: !hits.sheetBased }] };
        const m = /SELECT EXISTS \(SELECT 1 FROM (\w+) WHERE sheet_id=\$1 AND tab_name=\$2\) AS x/.exec(sql);
        if (m) return { rows: [{ x: !!hits[m[1]] }] };
        if (/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/.test(sql)) return { rows: [{ x: !!hits.manualSettlement }] };
        if (/FROM campaign_participants WHERE sheet_id=\$1 AND tab_name=\$2\s+AND \(order_submission_id IS NOT NULL/.test(sql)) return { rows: [{ x: !!hits.filled }] };
        if (/AS live,/.test(sql)) return { rows: [{ live: hits.liveCampaign ? 1 : 0, used: hits.usedCampaign ? 1 : 0 }] };
        if (/FROM work_orders w WHERE w\.deleted_at IS NULL AND w\.linked_tab_sheet_id=\$1/.test(sql)) return { rows: [{ x: !!hits.liveOrder }] };
        if (/^UPDATE work_orders SET linked_tab_sheet_id=''/.test(sql.trim())) return { rows: [{ id: 'wo1', title: '가짜 오더', status: 'reviewing', created_by: 'x' }], rowCount: 1 };
        if (/^DELETE|^UPDATE|^INSERT/.test(sql.trim())) return { rows: [], rowCount: 0 };
        return { rows: [] };
      },
      release() {},
    };
    return { log, pool: { async connect() { return client; }, async query(s, p) { return client.query(s, p); } } };
  };
  for (const [label, hits, reason] of [
    ['주문이 있으면', { order_submissions: 1 }, 'order_submissions'],
    ['사람이 고친 칸이 있으면', { participant_edits: 1 }, 'participant_edits'],
    ['채워진 줄이 있으면', { filled: 1 }, 'filled_rows'],
    ['사람이 정산 계약을 연결했으면', { manualSettlement: 1 }, 'trackb_settlement_links'],
    ['보관 안 된 공고가 있으면', { liveCampaign: 1 }, 'live_campaign'],
    ['공고에 참여·주문이 있으면', { usedCampaign: 1 }, 'campaign_used'],
    ['이어 쓰는 살아 있는 오더가 있으면', { liveOrder: 1 }, 'live_work_order'],
    ['시트 기반 작업이면', { sheetBased: 1 }, 'sheet_based'],
  ]) {
    await ok(`${label} 지우지 않는다(쓰기 0) → ${reason}`, async () => {
      const { log, pool } = mkPool(hits);
      const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, pool });
      assert.strictEqual(out.ok, false); assert.strictEqual(out.code, 'not_untouched'); assert.ok(out.reasons.includes(reason), JSON.stringify(out.reasons));
      assert.ok(!log.some(q => /^(DELETE|UPDATE|INSERT)/.test(q)), '쓰기 쿼리가 있으면 안 된다');
      assert.ok(log.includes('ROLLBACK'));
      assert.ok(log.findIndex(q => /pg_advisory_xact_lock/.test(q)) < log.findIndex(q => /tab_configs WHERE sheet_id/.test(q)), '잠근 뒤 판정');
    });
  }
  await ok('손대지 않은 빈 작업이면 지운다 · 오더는 링크만 해제 · 인트라넷 메모 푸시 없음', async () => {
    const { log, pool } = mkPool({});
    const memo = require('../src/services/intranetMemo.service');
    const orig = memo.pushIntranetMemo, origLog = memo.appendMemoLog; let pushed = 0, logged = null;
    memo.pushIntranetMemo = async () => { pushed++; return { delivered: true }; };
    memo.appendMemoLog = async (db, id, entry) => { logged = entry; };
    try {
      const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, onlyIfUntouched: true, notifyIntranet: false, pool });
      assert.strictEqual(out.ok, true);
      assert.ok(log.some(q => /^DELETE FROM tab_configs WHERE sheet_id=\$1 AND tab_name=\$2/.test(q)));
      assert.ok(log.some(q => /^UPDATE work_orders SET linked_tab_sheet_id=''/.test(q)));
      assert.strictEqual(pushed, 0, '인트라넷에서 지운 오더에 메모를 보내지 않는다');
      assert.ok(logged && logged.kind === 'tab_deleted' && logged.error === 'skipped_order_deleted', '기록은 남긴다');
      assert.strictEqual(out.workOrdersUnlinked, 1);
    } finally { memo.pushIntranetMemo = orig; memo.appendMemoLog = origLog; }
  });
  await ok('사람의 [작업 삭제](onlyIfUntouched 없음)는 종전 — 판정 쿼리 0', async () => {
    const { log, pool } = mkPool({ order_submissions: 1, liveCampaign: 1 });
    const out = await svc.deleteTask({ sheetId: 's', tabName: 't', confirm: true, pool });
    assert.strictEqual(out.ok, true);
    assert.ok(!log.some(q => /SELECT EXISTS \(SELECT 1 FROM order_submissions/.test(q)));
  });

  console.log('[3] 오더 삭제 훅');
  await ok('응답 뒤(setImmediate) 정리 · 절대 throw 없음 · 스위치', () => {
    const r = read('server/src/routes/order.routes.js');
    const d = r.slice(r.indexOf("router.delete('/intake/:id'"), r.indexOf('// 외부(인트라넷) 보낸 오더 수정'));
    assert.ok(/res\.json\(\{ ok: true, id \}\);[\s\S]*setImmediate\(\(\) => \{\s*require\('\.\.\/services\/workTabDelete\.service'\)\.autoCleanupDeletedOrderTab\(id, \{ by: _by \}\)/.test(d));
    const s = read('server/src/services/workTabDelete.service.js');
    const f = s.slice(s.indexOf('async function autoCleanupDeletedOrderTab'), s.indexOf('module.exports'));
    assert.ok(/INTAKE_DELETE_TAB_CLEANUP === '0'/.test(f));
    assert.ok(/confirm: true, onlyIfUntouched: true, notifyIntranet: false/.test(f));
    assert.ok(/catch \(e\) \{[\s\S]*return \{ ok: false, code: 'error'/.test(f));
    assert.ok(/WHERE id=\$1 AND deleted_at IS NOT NULL/.test(f), '지워진 오더만');
  });
  await ok('자동 정리는 드라이브·구글시트 무접촉(deleteDrive 넘기지 않음)', () => {
    const s = read('server/src/services/workTabDelete.service.js');
    const f = s.slice(s.indexOf('async function autoCleanupDeletedOrderTab'), s.indexOf('module.exports'));
    assert.ok(!/deleteDrive/.test(f));
  });

  console.log('[4] 홈 목록 "원본 오더 삭제됨"');
  await ok('살아 있는 오더(직접 연결·링크)가 없을 때만 · 실패 = ok:false', () => {
    const t = read('server/src/services/trackB.service.js');
    const f = t.slice(t.indexOf('async function sourceOrderDeletedMap'), t.indexOf('/** 마감/복귀.'));
    assert.ok(/NOT EXISTS \(SELECT 1 FROM work_orders w2 WHERE w2\.deleted_at IS NULL/.test(f));
    assert.ok(/NOT EXISTS \(SELECT 1 FROM trackb_work_order_links l JOIN work_orders w3/.test(f));
    assert.ok(/return \{ ok: false, map: \{\} \};/.test(f));
  });
  await ok('목록 응답은 홈 전용(stats=1) · 걸러진 탭에만 싣는다', () => {
    const r = read('server/src/routes/trackB.routes.js');
    assert.ok(/const sod = req\.query\.stats === '1' \? await svc\.sourceOrderDeletedMap\(\) : null;/.test(r));
    assert.ok(/if \(sod && sod\.map\[`\$\{t\.sheetId\}\\t\$\{t\.tabName\}`\]\) t\.sourceOrderDeleted = /.test(r));
  });
  await ok('화면: 상태 칸에 표시 · 값 없으면 그리지 않음 · 문구 이스케이프', () => {
    const w = read('frontend/workdesk.html');
    assert.ok(/const sod=t\.sourceOrderDeleted\?`<span class="wbl-s-sub"[^`]*title="\$\{esc\(/.test(w));
    assert.ok(/>원본 오더 삭제됨<\/span>`:'';/.test(w));
    assert.ok(/<td data-label="상태">\$\{st\}\$\{sod\}<\/td>/.test(w));
  });

  console.log(`\n✅ orderDeleteTabCleanup: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
