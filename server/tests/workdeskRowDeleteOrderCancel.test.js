/* 우클릭 행 삭제 = 구매기록 취소 + 총 모집인원 유지.
   스텁 DB 로 hideWorkdeskRow 를 실제 실행해, 두 가지를 고정한다.
   ① 살아 있는 구매양식이 붙은 행은 주문 취소와 "한 트랜잭션"으로 지워진다
   ② 지운 자리는 마지막 진행일의 빈 자리로 보충된다 = 총원이 줄지 않는다 */
const assert = require('assert');
const path = require('path');

const svc = require('../src/services/trackB.service');
const cancelPath = require.resolve('../src/services/orderCancellation.service');

const ORDER_ID = '11111111-2222-3333-4444-555555555555';

function makeStubPool({ liveOrder = true, sheetless = true, plans = [{ date: '2026-08-25', planned_count: 5 }],
  campaigns = [{ campaign_id: 'camp-1', is_open: true, is_linked: true }] } = {}) {
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
    if (q.includes('COALESCE(sheetless,FALSE) AS sheetless')) return { rows: [{ sheetless }] };
    if (q.includes('SELECT rc.id AS campaign_id')) return { rows: campaigns };
    if (q.includes('SELECT seq, tab_gid, row_json')) {
      return { rows: [{ seq: 7, tab_gid: '99', row_json: { '구매일자': '8/19 (수)' } }, { seq: 8, tab_gid: '99', row_json: { '구매일자': '8/25 (월)' } }] };
    }
    if (q.includes('FROM campaign_daily_plans') && q.includes('LIMIT 1')) return { rows: plans };
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
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'staff' });
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
      query: async (sql) => (String(sql).includes('COALESCE(sheetless,FALSE)') ? { rows: [{ sheetless: false }] } : client.query(sql)),
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
    assert.strictEqual(out.error, 'not_sheetless', '사유를 그대로 전달해야 합니다');
  }

  // ③ 권한: 구매기록이 붙은 행은 내부 담당자만 — 외부 역할은 쓰기 쿼리 0
  {
    const { pool, log } = makeStubPool({ liveOrder: true });
    svc.__setPoolForTest(pool);
    stubCancel(async () => { throw new Error('취소 경로에 도달하면 안 됩니다'); });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '광고주', actorRole: 'advertiser' });
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

  // ⑥ 예상 밖 오류(SQL·제약 등)는 500 마스킹으로 흘리지 않고 원인 코드를 돌려준다
  {
    const { pool, client } = makeStubPool({ liveOrder: true });
    const boom = Object.assign(new Error('column "nope" does not exist'), { code: '42703' });
    pool.connect = async () => ({
      query: async (sql) => (String(sql).includes('SELECT rc.id AS campaign_id') ? Promise.reject(boom) : client.query(sql)),
      release() {},
    });
    svc.__setPoolForTest(pool);
    stubCancel(async (args) => { await args.beforeCancelCommit(await pool.connect()); return { ok: true, cleared: false }; });
    let threw = false;
    let out;
    try { out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' }); }
    catch (_) { threw = true; }
    restoreCancel();
    assert.strictEqual(threw, false, '예상 밖 오류도 500 마스킹으로 흘리지 않고 응답으로 돌려줘야 합니다');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'unexpected');
    assert.strictEqual(out.pgCode, '42703', 'DB 오류코드를 그대로 전달해야 합니다');
    assert.ok(/nope/.test(out.detail || ''), '오류 내용도 전달해야 합니다');
  }

  // ⑦ 홀드 없이 들어온 주문(참여 기록 없음)도 연결 공고가 하나면 지울 수 있다
  //    — 종전에는 row_campaign_not_found 로 막혀 총원 유지로는 지울 방법이 없었다.
  {
    const { pool, client, log } = makeStubPool({
      liveOrder: true,
      campaigns: [{ campaign_id: 'camp-solo', is_open: true, is_linked: false }],
    });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => {});
    stubCancel(async (args) => { await args.beforeCancelCommit(client); return { ok: true, cleared: false }; });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    restoreCancel();
    assert.strictEqual(out.ok, true, `참여 기록 없는 주문도 삭제되어야 합니다: ${JSON.stringify(out)}`);
    assert.strictEqual(out.replenished, 1, '이 경로에서도 총원은 유지되어야 합니다');
    const planUpdate = log.find(l => l.sql.includes('planned_count=planned_count+1'));
    assert.ok(planUpdate && planUpdate.params[0] === 'camp-solo', '연결된 그 공고의 계획에 보충해야 합니다');
  }

  // ⑧ 연결 공고가 둘 이상이면 계획은 건드리지 않되, 행 삭제와 빈 자리 보충은 한다
  {
    const { pool, client, log } = makeStubPool({
      liveOrder: true,
      campaigns: [
        { campaign_id: 'camp-a', is_open: true, is_linked: false },
        { campaign_id: 'camp-b', is_open: true, is_linked: false },
      ],
    });
    svc.__setPoolForTest(pool);
    stubCancel(async (args) => { await args.beforeCancelCommit(client); return { ok: true, cleared: false }; });
    svc.__setLedgerRebuildForTest(async () => {});
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    restoreCancel();
    assert.strictEqual(out.ok, true, `공고가 모호해도 행 삭제는 되어야 합니다: ${JSON.stringify(out)}`);
    assert.strictEqual(out.campaignScope, 'ambiguous', '공고를 못 골랐다는 사실을 알려야 합니다');
    assert.strictEqual(out.replenished, 1, '보충은 작업보드에 한다');
    assert.strictEqual(out.planMoved, false, '어느 공고인지 모르면 공고 계획은 건드리지 않는다');
    assert.ok(!log.some(l => /campaign_daily_plans/.test(l.sql) && /UPDATE|INSERT/.test(l.sql)),
      '모호할 때 공고 계획 쓰기가 있으면 안 됩니다');
    assert.ok(log.some(l => /INSERT INTO campaign_participants/.test(l.sql)), '빈 자리는 만들어야 합니다');
  }

  // ⑨ 주문에 연결된 공고가 있으면 그 공고가 이긴다(다른 후보가 있어도)
  {
    const { pool, client, log } = makeStubPool({
      liveOrder: true,
      campaigns: [
        { campaign_id: 'camp-new', is_open: true, is_linked: false },
        { campaign_id: 'camp-linked', is_open: true, is_linked: true },
      ],
    });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => {});
    stubCancel(async (args) => { await args.beforeCancelCommit(client); return { ok: true, cleared: false }; });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    restoreCancel();
    assert.strictEqual(out.ok, true);
    const planUpdate = log.find(l => l.sql.includes('planned_count=planned_count+1'));
    assert.ok(planUpdate && planUpdate.params[0] === 'camp-linked', '그 주문이 참여한 공고가 우선이어야 합니다');
  }

  // ⑩ 마감된 공고 하나뿐이어도 지울 수 있다(계획 보충은 장부 정리일 뿐 재오픈이 아니다)
  {
    const { pool, client } = makeStubPool({
      liveOrder: false,
      campaigns: [{ campaign_id: 'camp-closed', is_open: false, is_linked: false }],
    });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => {});
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    assert.strictEqual(out.ok, true, `마감 공고 작업도 행 삭제가 되어야 합니다: ${JSON.stringify(out)}`);
  }

  // ⑪ 마감 공고와 게시 중 공고가 함께 있으면 게시 중인 쪽을 고른다(모호로 접지 않는다)
  {
    const { pool, client, log } = makeStubPool({
      liveOrder: false,
      campaigns: [
        { campaign_id: 'camp-old', is_open: false, is_linked: false },
        { campaign_id: 'camp-live', is_open: true, is_linked: false },
      ],
    });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => {});
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    assert.strictEqual(out.ok, true, `게시 중 공고가 하나면 고를 수 있어야 합니다: ${JSON.stringify(out)}`);
    const planUpdate = log.find(l => l.sql.includes('planned_count=planned_count+1'));
    assert.ok(planUpdate && planUpdate.params[0] === 'camp-live', '게시 중인 공고의 계획에 보충해야 합니다');
    void client;
  }

  // ⑫ 연결된 모집공고가 아예 없는 작업표(오늘 신고 — 네이버)0720_논알콜맥주3종)
  //    → 삭제되고, 빈 자리는 작업표의 마지막 진행일 표기 그대로 보충된다
  {
    const { pool, client, log } = makeStubPool({ liveOrder: true, campaigns: [] });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => {});
    stubCancel(async (args) => { await args.beforeCancelCommit(client); return { ok: true, cleared: true }; });
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    restoreCancel();
    assert.strictEqual(out.ok, true, `공고 없는 작업표도 삭제되어야 합니다: ${JSON.stringify(out)}`);
    assert.strictEqual(out.campaignScope, 'none');
    assert.strictEqual(out.replenished, 1, '총원은 작업보드 빈 자리로 유지한다');
    assert.strictEqual(out.planMoved, false);
    assert.strictEqual(out.replacementDate, '8/25 (월)', '작업표에서 가장 늦은 진행일 표기를 그대로 쓴다');
    const ins = log.find(l => /INSERT INTO campaign_participants/.test(l.sql));
    // ★ 다음 번호는 이 INSERT 자체가 표 전체(SELECT MAX(seq)...)에서 계산하므로 seq 는 더 이상
    //   자리표시자로 넘기지 않는다 — params 순서는 [sheetId, tabGid, tabName, start_date, row_json, by].
    assert.ok(ins && ins.params[3] === '8/25 (월)', '보충 슬롯의 구매일자가 그 값이어야 합니다');
    assert.ok(!log.some(l => /campaign_plan_events/.test(l.sql)), '공고가 없으면 공고 이력도 남기지 않는다');
  }

  svc.__setPoolForTest(null);
  svc.__setLedgerRebuildForTest(null);
  console.log('workdesk row delete → order cancel contract passed');
  process.exit(0);
})();
