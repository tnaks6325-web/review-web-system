/**
 * 회귀가드 — 인트라넷 페이백 장부 피드 (결정 290)
 *
 * 고정하는 것:
 *   §1 지급이 끝난 건(status='paid')만 싣는다 · 금액은 회차 박제값 그대로 · 큰 수(bigint 문자열)를 숫자로
 *   §2 개인정보(리뷰어 이름·phone8·은행·계좌·예금주)를 SELECT 하지도, 응답에 싣지도 않는다
 *   §3 작업 → 계약 = 탭 링크 우선, 없으면 작업오더 · 둘 다 없으면 null(빈 문자열로 꾸미지 않는다)
 *   §4 회차 id 검사 — 비었음·20개 초과·형식 오류는 400(조용히 버리지 않는다)
 *   §5 라우트 — 키는 헤더로만 · 키 미설정 503 · 틀린 키 401
 *
 * 실행: node tests/paybackLedgerFeed.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
const SRC = p => path.join(__dirname, '..', 'src', p);
const feed = require(SRC('services/paybackLedgerFeed.service'));

function stubDb(rowsFor) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql: String(sql), params }); return { rows: rowsFor(String(sql), params) || [] }; },
  };
}
const PERSONAL = ['reviewer_name', 'phone8', 'bank_name', 'bank_code', 'bank_account', 'account_holder'];
const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

(async () => {
  console.log('\n▶ paybackLedgerFeed 회귀가드\n');

  await ta('§1 회차 합계 — paid 만 합치고 bigint 문자열을 숫자로 돌린다', async () => {
    const db = stubDb(() => [{
      id: B1, seq: '12', bank: 'hana', status: 'applied', created_at: new Date('2026-10-01T01:00:00Z'), applied_at: null,
      paid_count: 3, product_sum: '45000', fee_sum: '9000', amount_sum: '54000',
      pending_count: 0, pending_amount: '0', first_paid_at: new Date('2026-10-02T03:00:00Z'),
      last_paid_at: new Date('2026-10-02T04:00:00Z'), fingerprint: 'abc',
    }]);
    const out = await feed.batchSummaries(db);
    assert.strictEqual(out[0].seq, 12);
    assert.strictEqual(out[0].product_sum, 45000);
    assert.strictEqual(out[0].amount_sum, 54000);
    assert.strictEqual(out[0].applied_at, null);
    assert.strictEqual(out[0].last_paid_at, '2026-10-02T04:00:00.000Z');
    const sql = db.calls[0].sql;
    assert(/SUM\(i\.amount\)\s+FILTER \(WHERE i\.status = 'paid'\)/.test(sql), '합계는 paid 만');
    assert(/md5\(/.test(sql), '지문이 있어야 바뀐 회차만 다시 가져간다');
  });

  await ta('§1 지급 건 — paid 만 · 금액 그대로', async () => {
    const db = stubDb(() => [{ id: 'it1', batch_id: B1, sheet_id: 's1', tab_name: '탭', row_index: 4, campaign_id: null,
      product_price: 15000, review_fee: 3000, amount: 18000, paid_at: new Date('2026-10-02T03:00:00Z') }]);
    const out = await feed.batchItems([B1], db);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.items[0], { id: 'it1', batch_id: B1, sheet_id: 's1', tab_name: '탭', row_index: 4, campaign_id: null,
      product_price: 15000, review_fee: 3000, amount: 18000, paid_at: '2026-10-02T03:00:00.000Z', adjusted: false, snapshot_amount: 0 });
    assert(/i\.status = 'paid'/.test(db.calls[0].sql));
    assert.deepStrictEqual(db.calls[0].params, [[B1]]);
  });

  await ta('§1 금액 조정 승인 건은 승인 기록의 실제 이체금액 — 합계·지문·건 목록이 같은 정의를 읽는다', async () => {
    const db = stubDb(() => []);
    await feed.batchSummaries(db);
    await feed.batchItems([B1], db);
    for (const c of db.calls) {
      assert(/LEFT JOIN payment_amount_mismatch_reconciliations r ON r\.batch_item_id = i\.id/.test(c.sql), '조정 승인 기록을 읽어야 한다');
      assert(/ROUND\(r\.actual_amount\)/.test(c.sql));
      assert(!/FROM payment_batch_items i\s+WHERE/.test(c.sql), '박제값만 읽는 옛 쿼리로 돌아가지 않는다');
    }
  });

  await ta('§3 작업오더 = 명시 링크(trackb_work_order_links) 우선', async () => {
    const db = stubDb(() => []);
    await feed.tabLinks(db);
    const sql = db.calls[0].sql;
    assert(/trackb_work_order_links l[\s\S]*l\.deleted_at IS NULL/.test(sql));
    assert(/ORDER BY \(l\.id IS NOT NULL\) DESC/.test(sql), '명시 링크가 먼저');
  });

  await ta('§2 개인정보 칸을 SELECT 하지 않는다(세 쿼리 모두)', async () => {
    const db = stubDb(() => []);
    await feed.batchSummaries(db);
    await feed.tabLinks(db);
    await feed.batchItems([B1], db);
    for (const c of db.calls) for (const col of PERSONAL) assert(!new RegExp('\\b' + col + '\\b').test(c.sql), col + ' 가 쿼리에 있다');
  });

  await ta('§2 원본 행에 개인정보가 섞여 와도 응답에는 싣지 않는다', async () => {
    const db = stubDb(() => [{ id: 'it1', batch_id: B1, sheet_id: 's', tab_name: 't', row_index: 1, product_price: 1, review_fee: 1, amount: 2,
      paid_at: null, reviewer_name: '홍길동', phone8: '12345678', bank_account: '1002' }]);
    const out = await feed.batchItems([B1], db);
    for (const col of PERSONAL) assert(!(col in out.items[0]), col);
  });

  await ta('§3 계약 연결 — 탭 링크 > 작업오더 > null', async () => {
    const db = stubDb(() => [
      { sheet_id: 's', tab_name: 'a', tab_label: 'A', link_sales_id: 'sales-L', link_contract_number: 'C-1', wo_sales_id: 'sales-W', wo_contract_number: 'C-2',
        work_order_id: 'wo_1', work_title: 'A 작업', source_review_order_id: 'ro1', intranet_advertiser_id: 'adv', intranet_advertiser_name: '업체' },
      { sheet_id: 's', tab_name: 'b', tab_label: 'B', link_sales_id: null, wo_sales_id: 'sales-W', wo_contract_number: 'C-2', work_order_id: 'wo_2' },
      { sheet_id: 's', tab_name: 'c', tab_label: null, link_sales_id: '', wo_sales_id: '', work_order_id: null },
    ]);
    const [a, b, c] = await feed.tabLinks(db);
    assert.strictEqual(a.sales_id, 'sales-L'); assert.strictEqual(a.contract_number, 'C-1'); assert.strictEqual(a.link_source, 'settlement_link');
    assert.strictEqual(b.sales_id, 'sales-W'); assert.strictEqual(b.contract_number, 'C-2'); assert.strictEqual(b.link_source, 'work_order');
    assert.strictEqual(c.sales_id, null); assert.strictEqual(c.link_source, null); assert.strictEqual(c.tab_label, 'c');
    assert(/trackb_settlement_links[\s\S]*deleted_at IS NULL/.test(db.calls[0].sql), '지운 탭 링크는 보지 않는다');
  });

  await ta('§4 회차 id 검사', async () => {
    const db = stubDb(() => []);
    assert.strictEqual((await feed.batchItems([], db)).ok, false);
    assert.strictEqual((await feed.batchItems(['x; drop'], db)).ok, false);
    const many = Array.from({ length: feed.MAX_BATCHES_PER_CALL + 1 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    assert.strictEqual((await feed.batchItems(many, db)).ok, false);
    assert.strictEqual(db.calls.length, 0, '검사에 걸리면 DB 를 부르지 않는다');
    assert.strictEqual((await feed.batchItems([B1, B1, ' ' + B2], db)).ok, true);
    assert.deepStrictEqual(db.calls[0].params, [[B1, B2]], '중복·공백 정리');
  });

  await ta('§5 라우트 — 헤더 키만 · 503/401', async () => {
    const router = require(SRC('routes/order.routes'));
    const layer = router.stack.find(l => l.route && l.route.path === '/payback-ledger/summary');
    const itemsLayer = router.stack.find(l => l.route && l.route.path === '/payback-ledger/items');
    assert(layer && itemsLayer, '두 경로가 있어야 한다');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const call = async (headers, query = {}) => {
      const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ headers, query }, res, e => { throw e; });
      return res;
    };
    const saved = process.env.ORDER_INTAKE_KEY;
    try {
      delete process.env.ORDER_INTAKE_KEY;
      assert.strictEqual((await call({ 'x-intake-key': 'k' })).code, 503);
      process.env.ORDER_INTAKE_KEY = 'secret-key';
      assert.strictEqual((await call({ 'x-intake-key': 'wrong' })).code, 401);
      assert.strictEqual((await call({}, { intakeKey: 'secret-key' })).code, 401, '주소(쿼리)의 키는 받지 않는다');
    } finally {
      if (saved === undefined) delete process.env.ORDER_INTAKE_KEY; else process.env.ORDER_INTAKE_KEY = saved;
    }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})();
