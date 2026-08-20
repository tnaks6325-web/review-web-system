'use strict';
/**
 * 회귀가드 — 계약 후속 매칭(인트라넷)이 접수된 작업오더에도 붙는다.
 *
 * 실행: node tests/reviewOrderContractOnlyRevision.test.js
 *
 * ★ 배경(2026-08-20 실장애): 인트라넷 [계약 매칭] → PUT /intake/source/:id 가
 *   "이미 접수·게시 기준이 확정된 작업오더는 …" 409 로 전부 거부됐다. 계약 후속 매칭은
 *   접수가 끝난 뒤에 오는 것이 정상이라(공고가 붙어 있다), 그 잠금이 곧 "계약을 영영
 *   못 붙임"이었다. 인트라넷에는 계약이 저장되고 리뷰웹에는 안 붙는 불일치까지 남았다.
 *
 * ★ 이 가드가 지키는 것:
 *   ① 잠긴 오더 + 계약/광고주 칸만 바뀐 요청 → 통과(200, contract_only), 계약 칸만 UPDATE
 *   ② 잠긴 오더 + 작업 내용이 바뀐 요청 → 종전대로 409 (+ 바뀐 칸 이름을 알려준다)
 *   ③ 계약 전용 경로는 정원 검증·작업표 동기화를 건드리지 않는다(접수 상태 보존)
 *   ④ 잠기지 않은 오더는 종전 전체 수정 경로 그대로
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key';

const pool = require(path.join(ROOT, 'src/db/pool.js'));
const quotaService = require(path.join(ROOT, 'src/services/linkedRecruitQuota.service.js'));
const { pickWorkManager } = require(path.join(ROOT, 'src/utils/workManager.js'));
const { workKindForStore } = require(path.join(ROOT, 'src/utils/workKind.js'));

// 정원 검증·작업표 동기화는 호출 여부만 본다(실 DB 없음).
const calls = { quota: 0, sync: 0 };
quotaService.assertWorkOrderQuota = async () => { calls.quota += 1; return null; };
quotaService.syncWorkOrderRecruitTotal = async () => { calls.sync += 1; return null; };

const orderRouter = require(path.join(ROOT, 'src/routes/order.routes.js'));

const layer = (orderRouter.stack || []).find(l =>
  l.route && l.route.path === '/intake/source/:sourceReviewOrderId' && l.route.methods.put);
assert.ok(layer, 'PUT /intake/source/:sourceReviewOrderId 라우트 없음');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const BODY = {
  intakeKey: 'test-intake-key',
  source_review_order_id: 'ro_abc123',
  source_revision: 2,
  idempotency_key: 'ro_abc123:2',
  title: '8/19(네이버)좋은상황 상황버섯진액 10포 300건 실배송',
  start_date: '2026-08-19',
  manager_name: '김수만',
  work_manager: '박세희',
  product_option: '10포',
  pay_amount: 29000,
  review_fee: 0,
  daily_count: 10,
  daily_count_text: '10',
  purchase_channel: '네이버',
  purchase_time: '09:00 ~ 18:00',
  inflow_keyword: '상황버섯진액',
  inflow_type: '검색',
  inflow_guide: '검색 후 구매',
  delivery_type: '실배송',
  review_type: '포토',
  recruit_count: 300,
  review_guide: '직접 사용 후 작성',
  special_notes: '',
  product_url: 'https://smartstore.naver.com/x',
  work_sheet_url: '',
  goods_cost_type: '계산서',
  work_kind: '리뷰체험단',
  // 계약 후속 매칭으로 새로 채워지는 칸
  sales_id: 'e722ef1a-cb0c-4483-9e11-509bb5da15f4',
  contract_number: 'C-20260820-005',
  quote_id: 'q-1',
  intranet_advertiser_id: 'adv-1',
  intranet_advertiser_name: '주식회사 어니스트캄',
  intranet_advertiser_contact: '010-0000-0000',
  intranet_advertiser_business_number: '000-00-00000',
};

// 현재 작업오더 = BODY 와 "작업 내용"이 같고 계약 칸만 비어 있는 접수된 오더.
function baseOrder(extra) {
  return Object.assign({
    id: 'wo_0e8d6598058f',
    source_review_order_id: 'ro_abc123',
    source_revision: 1,
    intake_idempotency_key: 'ro_abc123:1',
    status: 'reviewing',
    deleted_at: null,
    linked_campaign_id: 'camp_1',      // ← 공고 생성됨(잠금 조건)
    advertiser_id: null,
    title: BODY.title,
    start_date: new Date(2026, 7, 19),  // pg DATE → 로컬 자정 Date
    manager_name: BODY.manager_name,
    work_manager: pickWorkManager(BODY),
    product_option: BODY.product_option,
    product_options_json: '',
    pay_amount: BODY.pay_amount,
    review_fee: 0,
    daily_count: BODY.daily_count,
    daily_count_text: BODY.daily_count_text,
    purchase_channel: BODY.purchase_channel,
    purchase_time: BODY.purchase_time,
    inflow_keyword: BODY.inflow_keyword,
    inflow_type: BODY.inflow_type,
    inflow_guide: BODY.inflow_guide,
    guide_images: '',
    delivery_type: '실배송',
    courier_proxy: false,
    review_type: BODY.review_type,
    review_type_mix: [],                // JSONB → 파싱된 배열로 온다
    recruit_count: BODY.recruit_count,
    review_guide: BODY.review_guide,
    special_notes: '',
    product_url: BODY.product_url,
    work_sheet_url: '',
    goods_cost_type: BODY.goods_cost_type,
    skip_weekends: null,
    holidays: null,
    work_kind: workKindForStore(BODY.work_kind),
    sales_id: '',
    contract_number: '',
    quote_id: '',
  }, extra || {});
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}

async function call(order, body) {
  const queries = [];
  pool.query = async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/SELECT \* FROM work_orders WHERE source_review_order_id/.test(s)) return { rows: [Object.assign({}, order)] };
    if (/UPDATE work_orders SET/.test(s)) return { rows: [Object.assign({}, order, { source_revision: 2 })] };
    return { rows: [] };
  };
  calls.quota = 0; calls.sync = 0;
  const res = makeRes();
  await handler({ body, params: { sourceReviewOrderId: body.source_review_order_id }, headers: {} }, res,
    err => { throw err; });
  return { res, queries, updates: queries.filter(q => /UPDATE work_orders SET/.test(q.sql)) };
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

async function run() {
  console.log('\n계약 후속 매칭 — 접수된 작업오더 예외');

  await t('① 공고가 붙은 오더라도 계약/광고주 칸만 바뀐 요청은 통과한다', async () => {
    const { res } = await call(baseOrder(), BODY);
    assert.strictEqual(res.statusCode, 200, 'status=' + res.statusCode + ' body=' + JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.contract_only, true, '계약 전용 응답 표시가 없다');
  });

  await t('① UPDATE 는 계약·광고주 칸만 건드린다(작업 내용 칸은 안 쓴다)', async () => {
    const { updates } = await call(baseOrder(), BODY);
    assert.strictEqual(updates.length, 1, 'UPDATE 가 1회여야 한다');
    const sql = updates[0].sql;
    ['sales_id', 'contract_number', 'quote_id', 'intranet_advertiser_id', 'source_revision',
      'intake_idempotency_key'].forEach(col => assert.ok(new RegExp(col + ' =').test(sql), '누락: ' + col));
    ['title =', 'recruit_count =', 'review_guide =', 'start_date =', 'work_sheet_url ='].forEach(col =>
      assert.ok(!sql.includes(col), '계약 전용 UPDATE 가 작업 내용을 건드림: ' + col));
  });

  await t('③ 계약 전용 경로는 정원 검증·작업표 동기화를 호출하지 않는다', async () => {
    await call(baseOrder(), BODY);
    assert.strictEqual(calls.quota, 0, 'assertWorkOrderQuota 가 호출됐다');
    assert.strictEqual(calls.sync, 0, 'syncWorkOrderRecruitTotal 이 호출됐다');
  });

  await t('② 잠긴 오더에서 작업 내용이 바뀌면 종전대로 409 + 바뀐 칸을 알려준다', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { title: '제목을 바꾼 요청' }));
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /이미 접수·게시 기준이 확정된/);
    assert.ok(Array.isArray(res.body.changed_fields) && res.body.changed_fields.includes('title'),
      'changed_fields 에 title 이 없다: ' + JSON.stringify(res.body.changed_fields));
  });

  await t('② 인원 변경도 계약 전용으로 오해하지 않는다', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { recruit_count: 500 }));
    assert.strictEqual(res.statusCode, 409);
    assert.ok(res.body.changed_fields.includes('recruit_count'));
  });

  await t('① 완료·게시 오더도 정산을 위해 계약은 붙일 수 있다', async () => {
    const done = await call(baseOrder({ status: 'done', linked_campaign_id: '' }), BODY);
    assert.strictEqual(done.res.statusCode, 200, '완료 오더: ' + JSON.stringify(done.res.body));
    const published = await call(baseOrder({ status: 'published', linked_campaign_id: '' }), BODY);
    assert.strictEqual(published.res.statusCode, 200, '모집중 오더: ' + JSON.stringify(published.res.body));
  });

  await t('② 삭제된 작업오더는 계약 매칭도 막는다(예외 없음)', async () => {
    const { res } = await call(baseOrder({ deleted_at: new Date(), linked_campaign_id: '' }), BODY);
    assert.strictEqual(res.statusCode, 409, '삭제 오더에 계약이 붙었다: ' + JSON.stringify(res.body));
  });

  await t('④ 잠기지 않은 오더는 종전 전체 수정 경로 그대로', async () => {
    const { res, updates } = await call(baseOrder({ linked_campaign_id: '', advertiser_id: null }),
      Object.assign({}, BODY, { title: '내용까지 바꾼 원본 수정' }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!res.body.contract_only, '전체 수정인데 contract_only 로 응답');
    assert.ok(updates[0].sql.includes('title ='), '전체 UPDATE 가 아니다');
    assert.strictEqual(calls.quota, 1, '정원 검증이 빠졌다');
  });

  console.log(`\nreviewOrderContractOnlyRevision: ${pass} 통과 / ${fail} 실패\n`);
  process.exit(fail ? 1 : 0);   // SSE 하트비트 타이머가 살아 있어 명시 종료(다른 라우트 테스트와 같은 관례)
}

run().catch(err => { console.error(err); process.exit(1); });
