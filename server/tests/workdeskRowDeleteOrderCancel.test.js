/* 우클릭 행 삭제 = 구매기록 취소 + 총 모집인원 유지.
   스텁 DB 로 hideWorkdeskRow 를 실제 실행해, 두 가지를 고정한다.
   ① 살아 있는 구매양식이 붙은 행은 주문 취소와 "한 트랜잭션"으로 지워진다
   ② 지운 자리는 마지막 진행일의 빈 자리로 보충된다 = 총원이 줄지 않는다 */
const assert = require('assert');
const path = require('path');

const svc = require('../src/services/trackB.service');
const cancelPath = require.resolve('../src/services/orderCancellation.service');

const ORDER_ID = '11111111-2222-3333-4444-555555555555';

function makeStubPool({ liveOrder = true } = {}) {
  const log = [];
  const answer = (sql, params) => {
    log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    const q = String(sql);
    if (q.includes('FROM campaign_participants cp') && q.includes('JOIN order_submissions')) {
      return { rows: liveOrder ? [{ oid: ORDER_ID }] : [] };
    }
    if (q.includes('SELECT id, seq, phone8, row_json, order_submission_id')) {
      return { rows: [{ id: 'row-1', seq: 7, phone8: '12345678', row_json: { '구매일자': '8/19 (수)' }, order_submission_id: liveOrder ? ORDER_ID : null }] };
    }
    if (q.includes('SELECT rc.id AS campaign_id')) return { rows: [{ campaign_id: 'camp-1' }] };
    if (q.includes('SELECT seq, tab_gid, row_json')) {
      return { rows: [{ seq: 7, tab_gid: '99', row_json: { '구매일자': '8/19 (수)' } }, { seq: 8, tab_gid: '99', row_json: { '구매일자': '8/25 (월)' } }] };
    }
    if (q.includes('FROM campaign_daily_plans') && q.includes('LIMIT 1')) return { rows: [{ date: '2026-08-25', planned_count: 5 }] };
    if (q.includes('FROM campaign_daily_plans') && q.includes('plan_date=$2::date')) return { rows: [{ date: '2026-08-19', planned_count: 3 }] };
    if (q.includes('DELETE FROM campaign_participants')) return { rowCount: 1, rows: [] };
    if (q.includes('DELETE FROM participation_links')) return { rowCount: 1, rows: [] };
    if (q.includes('UPDATE campaign_applications')) return { rowCount: 1, rows: [] };
    if (q.includes('INSERT INTO campaign_participants')) return { rowCount: 1, rows: [{ id: 'row-new', seq: 9 }] };
    return { rowCount: 0, rows: [] };
  };
  const client = { query: async (sql, params) => answer(sql, params), release() {} };
  return { log, pool: { query: async (sql, params) => answer(sql, params), connect: async () => client }, client };
}

function stubCancel(impl) { require.cache[cancelPath] = { id: cancelPath, filename: cancelPath, loaded: true, exports: { cancelOrderSubmission: impl } }; }
function restoreCancel() { delete require.cache[cancelPath]; }

(async () => {
  // ① 구매양식이 붙은 행 — 주문 취소 트랜잭션 안에서 행이 지워진다
  {
    const { pool, client, log } = makeStubPool({ liveOrder: true });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => {});
    let seen = null;
    stubCancel(async (args) => {
      seen = args;
      assert.strictEqual(args.orderSubmissionId, ORDER_ID, '그 행에 연결된 주문만 취소해야 합니다');
      await args.beforeCancelCommit(client);   // 같은 트랜잭션의 client 를 넘긴다
      return { ok: true, cleared: true };
    });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    restoreCancel();
    assert.ok(seen, '살아 있는 구매양식이 있으면 주문 취소 경로를 타야 합니다');
    assert.strictEqual(typeof seen.beforeCancelCommit, 'function', '행 제거는 취소와 같은 트랜잭션이어야 합니다');
    assert.strictEqual(out.ok, true, `삭제가 성공해야 합니다: ${JSON.stringify(out)}`);
    assert.strictEqual(out.orderCanceled, true, '구매기록 취소 사실을 화면에 알려야 합니다');
    assert.strictEqual(out.sheetCleared, true, '시트 주문값 비우기 여부도 알려야 합니다');
    // ★ 총원 유지: 보충 슬롯 INSERT + 마지막 진행일 계획 +1
    assert.strictEqual(out.replenished, 1, '지운 자리는 빈 자리로 보충되어야 합니다(총원 유지)');
    const sqls = log.map(l => l.sql);
    assert.ok(sqls.some(s => s.includes('INSERT INTO campaign_participants')), '보충 슬롯을 만들어야 합니다');
    assert.ok(sqls.some(s => s.includes('planned_count=planned_count+1')), '마지막 진행일 계획을 1건 늘려야 합니다');
    assert.ok(!sqls.some(s => s.includes('recruit_total')), '총 모집수 자체를 건드리면 안 됩니다');
  }

  // ② 본문이 실패하면 주문 취소도 함께 롤백된다(한쪽만 반영 금지)
  {
    const { pool, client } = makeStubPool({ liveOrder: true });
    pool.connect = async () => ({
      query: async (sql) => (String(sql).includes('SELECT rc.id AS campaign_id') ? { rows: [] } : client.query(sql)),
      release() {},
    });
    svc.__setPoolForTest(pool);
    let committed = true;
    stubCancel(async (args) => {
      try { await args.beforeCancelCommit(await pool.connect()); }
      catch (e) { committed = false; throw e; }   // 실제 서비스도 여기서 ROLLBACK 한다
      return { ok: true, cleared: false };
    });
    let out;
    try { out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' }); }
    catch (e) { out = { ok: false, error: e && e.code }; }
    restoreCancel();
    assert.strictEqual(committed, false, '본문 실패는 주문 취소까지 롤백시켜야 합니다');
    assert.strictEqual(out.ok, false, '실패는 실패로 알려야 합니다');
    assert.strictEqual(out.error, 'row_campaign_not_found', '사유를 그대로 전달해야 합니다');
  }

  // ③ 권한: 구매기록이 붙은 행은 master/admin 만 — 쓰기 쿼리 0
  {
    const { pool, log } = makeStubPool({ liveOrder: true });
    svc.__setPoolForTest(pool);
    stubCancel(async () => { throw new Error('취소 경로에 도달하면 안 됩니다'); });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: 'AE', actorRole: 'staff' });
    restoreCancel();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'order_cancel_forbidden');
    assert.ok(!log.some(l => /DELETE|INSERT|UPDATE/.test(l.sql)), '권한 거부 시 쓰기 쿼리가 하나도 없어야 합니다');
  }

  // ④ 주문 없는 행은 종전 그대로 — 취소 경로를 타지 않는다
  {
    const { pool } = makeStubPool({ liveOrder: false });
    svc.__setPoolForTest(pool);
    stubCancel(async () => { throw new Error('주문 없는 행이 취소 경로를 타면 안 됩니다'); });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: 'AE', actorRole: 'staff' });
    restoreCancel();
    assert.strictEqual(out.ok, true, `주문 없는 행 삭제는 담당자도 할 수 있어야 합니다: ${JSON.stringify(out)}`);
    assert.strictEqual(out.orderCanceled, false, '취소할 구매기록이 없으면 취소했다고 말하면 안 됩니다');
    assert.strictEqual(out.replenished, 1, '총원은 여기서도 유지되어야 합니다');
  }

  // ⑤ 주문 조회 실패는 "주문 없음"으로 접지 않는다(구매양식이 남은 채 행만 사라지는 것 차단)
  {
    svc.__setPoolForTest({ query: async () => { throw new Error('db down'); }, connect: async () => { throw new Error('db down'); } });
    stubCancel(async () => { throw new Error('도달하면 안 됩니다'); });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    restoreCancel();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'order_lookup_failed', '모르면 지우지 않는다');
  }

  svc.__setPoolForTest(null);
  svc.__setLedgerRebuildForTest(null);
  console.log('workdesk row delete → order cancel contract passed');
  process.exit(0);
})();
