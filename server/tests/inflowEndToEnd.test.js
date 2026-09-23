'use strict';
/**
 * 회귀가드 — **끝까지 이어 보기**: 인트라넷 수정 → 리뷰웹 저장 → 공고 전파 → 리뷰어 응답 → 리뷰어 화면
 *
 * 실행: node tests/inflowEndToEnd.test.js
 *
 * ★★★ 왜 따로 두는가(사용자 지적 2026-09-22 "리뷰어가 확인하는 순간까지 적용되는지 테스트했니") —
 *    각 조각이 따로 통과해도 **중간이 끊기면 리뷰어 화면은 옛 값 그대로**다. 이 가드는 한 흐름을
 *    실제로 태워서 ① 저장 ② 공고에 남은 값 ③ 리뷰어가 받는 응답(정화 후) ④ 화면 HTML 까지 본다.
 * ★★ 가짜 DB 지만 **쓴 값을 기억하고 되돌리기도 흉내낸다** — 되돌리기를 흉내내지 않으면
 *    "거부했는데 값은 바뀐" 것처럼 보여 오판한다(개발 중 실제로 밟았다).
 * ★ 검사하는 것: 링크→가이드 전환이 리뷰어 화면까지 가는가 · [상품 페이지 열기]가 사라지는가 ·
 *   되돌리면 돌아오는가 · 가이드가 빈 선택지가 있으면 막히고 공고가 그대로인가.
 *
 * 원래 목적:
   ★ 가짜 DB 지만 **쓴 값을 기억**해 다음 단계가 그것을 읽는다(지금까지의 스텁은 읽기가 고정값이었다). */
const path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = 'x'; process.env.ORDER_INTAKE_KEY = 'k';

const IMG = 'https://api.example.com/api/order/guide-image/' + 'a'.repeat(22);

/* ── 가짜 DB(상태를 들고 있다) ─────────────────────────────────────────── */
const DB = {
  wo: { id: 'wo_1', source_review_order_id: 'ro_1', source_revision: 1, intake_idempotency_key: 'ro_1:1',
    status: 'reviewing', deleted_at: null, linked_campaign_id: 'camp_1', advertiser_id: 'a1',
    title: 'T', start_date: new Date(2026, 8, 9), manager_name: 'M', work_manager: '박세희',
    product_option: '', product_options_json: '', product_distribution_mode: 'balanced',
    pay_amount: 100, review_fee: 0, daily_count: 30, daily_count_text: '30', purchase_channel: '쿠팡',
    purchase_time: '10:00 ~ 12:00', inflow_keyword: '', inflow_type: 'link', inflow_guide: '', guide_images: '',
    delivery_type: '실배송', courier_proxy: false, review_type: '포토', review_type_mix: [],
    recruit_count: 10, review_guide: 'G', special_notes: '', product_url: 'https://x/y',
    work_sheet_url: '', goods_cost_type: '계산서', skip_weekends: null, holidays: null,
    work_kind: 'review', sales_id: 's', contract_number: 'c', quote_id: 'q', thumbnail_url: '' },
  camp: { id: 'camp_1', participation_mode: true, status: 'active', title: '공고',
    work_detail: { inflowType: 'link', productLines: '상품 - 결제금액 10,000원', payAmount: 10000 },
    window_start: '10:00:00', window_end: '12:00:00', landing_url: 'https://shop.example/p/1',
    chat_url: '', linked_sheet_id: '', linked_tab_name: '', linked_tab_gid: '',
    source_work_order_id: 'wo_1', recruit_total: 10, daily_limit: 5, hold_ttl_min: 15 },
  options: [],   // 옵션 없는 공고
  app: { id: 'app_1', status: 'applied', expires_at: new Date(Date.now() + 9e5), applied_at: new Date(),
    submitted_at: null, option_key: null, reject_reason: null, decided_at: null },
};

/* ★ 진짜 DB 처럼 되돌리기를 흉내낸다 — BEGIN 에서 스냅샷, ROLLBACK 이면 되돌린다.
   이게 없으면 "거부했는데 값은 바뀐" 것처럼 보여 오판한다(실제로 밟았다). */
let SNAP = null;
function answer(sql, params) {
  const s = String(sql);
  if (/^\s*BEGIN/i.test(s)) { SNAP = JSON.stringify({ camp: DB.camp, options: DB.options }); return { rows: [], rowCount: 0 }; }
  if (/^\s*ROLLBACK/i.test(s)) {
    if (SNAP) { const p = JSON.parse(SNAP); DB.camp = p.camp; DB.options = p.options; SNAP = null; }
    return { rows: [], rowCount: 0 };
  }
  if (/^\s*COMMIT/i.test(s)) { SNAP = null; return { rows: [], rowCount: 0 }; }
  if (/SELECT \* FROM work_orders WHERE source_review_order_id/.test(s)) return { rows: [Object.assign({}, DB.wo)] };
  if (/UPDATE work_orders SET/.test(s)) {
    // SET 목록의 칸에 파라미터를 반영한다(원본 수정이 실제로 값을 바꾼 것으로 본다)
    const sets = [...s.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/g)];
    sets.forEach(([, col, n]) => { if (col !== 'id') DB.wo[col] = params[Number(n) - 1]; });
    return { rows: [Object.assign({}, DB.wo)] };
  }
  if (/FROM work_orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: DB.wo.id, linked_campaign_id: DB.wo.linked_campaign_id }] };
  if (/FROM recruit_campaigns\s+WHERE \(id = \$1/.test(s)) return { rows: [Object.assign({}, DB.camp)] };
  if (/SELECT work_detail FROM recruit_campaigns/.test(s)) return { rows: [{ work_detail: DB.camp.work_detail }] };
  if (/SELECT participation_mode FROM recruit_campaigns/.test(s)) return { rows: [{ participation_mode: DB.camp.participation_mode }] };
  if (/UPDATE recruit_campaigns SET work_detail/.test(s)) { DB.camp.work_detail = JSON.parse(params[1]); return { rowCount: 1, rows: [] }; }
  if (/UPDATE recruit_campaigns SET window_start/.test(s)) {
    const same = DB.camp.window_start === params[1] && DB.camp.window_end === params[2];
    DB.camp.window_start = params[1]; DB.camp.window_end = params[2];
    return { rowCount: same ? 0 : 1, rows: [] };
  }
  if (/UPDATE campaign_options\s+SET\s+inflow_guide_html/.test(s)) {
    const o = DB.options.find(x => x.opt_key === params[1]);
    if (o) { o.inflow_guide_html = params[2]; o.inflow_guide_images = JSON.parse(params[3]); }
    return { rowCount: 1, rows: [] };
  }
  if (/FROM campaign_options/.test(s)) return { rows: DB.options.map(o => Object.assign({}, o)) };
  if (/SELECT \* FROM recruit_campaigns WHERE id = \$1/.test(s)) return { rows: [Object.assign({}, DB.camp)] };
  if (/FROM campaign_applications/.test(s)) return { rows: [Object.assign({}, DB.app)] };
  return { rows: [], rowCount: 0 };
}

const pool = require(path.join(ROOT, 'src/db/pool.js'));
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release: () => {} });
const svc = require(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'));
svc.__setPoolForTest({ connect: pool.connect });
const q2 = require(path.join(ROOT, 'src/services/linkedRecruitQuota.service.js'));
q2.assertWorkOrderQuota = async () => null; q2.syncWorkOrderRecruitTotal = async () => null;

/* ── 1) 인트라넷이 보낸 수정 ─────────────────────────────────────────── */
const orderRouter = require(path.join(ROOT, 'src/routes/order.routes.js'));
const L1 = orderRouter.stack.find(l => l.route && l.route.path === '/intake/source/:sourceReviewOrderId' && l.route.methods.put);
const editHandler = L1.route.stack[L1.route.stack.length - 1].handle;

const BODY = { intakeKey: 'k', source_review_order_id: 'ro_1', source_revision: 2, idempotency_key: 'ro_1:2',
  title: 'T', start_date: '2026-09-09', manager_name: 'M', work_manager: '박세희', product_option: '',
  product_options_json: '', pay_amount: 100, review_fee: 0, daily_count: 30, daily_count_text: '30',
  product_distribution_mode: 'balanced', purchase_channel: '쿠팡',
  purchase_time: '오후 2시 ~ 5시',                                   // ← 바꾼 값 ①
  inflow_keyword: '', inflow_type: 'guide',                          // ← 바꾼 값 ②
  inflow_guide: '네이버에서 "상황버섯" 검색 후 3번째 상품\n' + IMG,   // ← 바꾼 값 ③ (글 + 사진)
  delivery_type: '실배송', review_type: '포토', recruit_count: 10, review_guide: 'G', special_notes: '',
  product_url: 'https://x/y', work_sheet_url: '', goods_cost_type: '계산서', work_kind: 'review',
  sales_id: 's', contract_number: 'c', quote_id: 'q', intranet_advertiser_id: 'adv',
  intranet_advertiser_name: 'N', intranet_advertiser_contact: '010', intranet_advertiser_business_number: '000' };

function mkRes() { const r = { statusCode: 200, body: null }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; }

(async () => {
  const r1 = mkRes();
  await editHandler({ body: BODY, params: { sourceReviewOrderId: 'ro_1' }, headers: {} }, r1, e => { throw e; });
  // 1~3 단계 단언은 각 console.log 뒤에 있다
  console.log('1) 인트라넷 수정 저장 →', r1.statusCode, JSON.stringify({
    바뀐칸: r1.body && r1.body.edited_fields,
    유입전파: r1.body && r1.body.campaign_inflow_sync,
    시간창전파: r1.body && r1.body.campaign_time_sync }));
  assert.strictEqual(r1.statusCode, 200);
  assert.strictEqual(r1.body.campaign_inflow_sync.applied, true, '유입 전파가 안 됐다');
  assert.strictEqual(r1.body.campaign_time_sync.applied, true, '시간창 전파가 안 됐다');

  console.log('2) 공고에 실제로 남은 값 →', JSON.stringify({
    유입방식: DB.camp.work_detail.inflowType,
    안내글: String(DB.camp.work_detail.inflowGuideHtml || '').slice(0, 90),
    시간창: DB.camp.window_start + '~' + DB.camp.window_end }));
  assert.strictEqual(DB.camp.work_detail.inflowType, 'guide', '공고에 유입방식이 안 남았다');
  assert.ok(/상황버섯/.test(String(DB.camp.work_detail.inflowGuideHtml || '')), '공고에 안내 글이 안 남았다');
  assert.strictEqual(DB.camp.window_start, '14:00:00', '공고 시간창이 안 바뀌었다');

  /* ── 3) 리뷰어가 받는 응답 ─────────────────────────────────────────── */
  const campRouter = require(path.join(ROOT, 'src/routes/campaign.routes.js'));
  const L2 = campRouter.stack.find(l => l.route && /work-detail/.test(l.route.path) && l.route.methods.get);
  const wdHandler = L2.route.stack[L2.route.stack.length - 1].handle;
  const r2 = mkRes();
  await wdHandler({ params: { id: 'camp_1' }, query: { phone8: '12345678', holdToken: 't' }, headers: {}, ip: '1.1.1.1' }, r2, e => { throw e; });
  console.log('3) 리뷰어 응답 →', r2.statusCode, JSON.stringify({
    유입방식: r2.body && r2.body.inflowType,
    안내글: r2.body && String((r2.body.workDetail || {}).inflowGuideHtml || '').slice(0, 90) }));
  assert.strictEqual(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.strictEqual(r2.body.inflowType, 'guide', '리뷰어 응답의 유입방식이 안 바뀌었다');
  // ★ 응답 직전 정화(sanitize)를 통과해야 한다 — 사진이 걸러지면 화면에 안 뜬다
  assert.ok(/<img[^>]*guide-image/.test(String((r2.body.workDetail || {}).inflowGuideHtml || '')),
    '정화 과정에서 사진이 사라졌다');

  /* ── 4) 리뷰어 화면 HTML ───────────────────────────────────────────── */
  const src = fs.readFileSync(path.join(ROOT, '../frontend/js/campaign-workdetail.js'), 'utf8');
  const sb = { window: {}, document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }, console };
  vm.createContext(sb); vm.runInContext(src, sb);
  const html = sb.window.CampWorkDetail.cardsHtml(r2.body, {});
  const R4 = {
    유입가이드카드: /🧭/.test(html),
    새안내글보임: /상황버섯/.test(html),
    사진보임: /<img[^>]*guide-image/.test(html),
    상품페이지열기버튼: /상품 페이지 열기/.test(html),
    noGuide: /등록된 유입가이드가 없어요/.test(html) };
  console.log('4) 리뷰어 화면 →', JSON.stringify(R4));
  assert.ok(R4['유입가이드카드'], '리뷰어 화면에 유입가이드 카드가 없다');
  assert.ok(R4['새안내글보임'], '고친 안내 글이 리뷰어 화면에 없다 — 중간에서 끊겼다');
  assert.ok(R4['사진보임'], '첨부 사진이 리뷰어 화면까지 안 갔다');
  assert.ok(!R4['상품페이지열기버튼'], '가이드유입인데 [상품 페이지 열기]가 남았다 — 유입가이드가 무력화된다');
  assert.ok(!R4.noGuide, '가이드를 넣었는데 "없어요" 로 보인다');

  /* ── 5) 되돌리기: 가이드 → 링크 ─────────────────────────────────────── */
  DB.wo.source_revision = 2; DB.wo.intake_idempotency_key = 'ro_1:2';
  const B2 = Object.assign({}, BODY, { source_revision: 3, idempotency_key: 'ro_1:3', inflow_type: 'link' });
  const r3 = mkRes();
  await editHandler({ body: B2, params: { sourceReviewOrderId: 'ro_1' }, headers: {} }, r3, e => { throw e; });
  const r4 = mkRes();
  await wdHandler({ params: { id: 'camp_1' }, query: { phone8: '12345678', holdToken: 't' }, headers: {}, ip: '1.1.1.1' }, r4, e => { throw e; });
  const html2 = sb.window.CampWorkDetail.cardsHtml(r4.body, {});
  const R5 = { 저장: r3.statusCode, 유입방식: r4.body.inflowType, 상품페이지열기버튼: /상품 페이지 열기/.test(html2) };
  console.log('5) 링크유입으로 되돌림 →', JSON.stringify(R5));
  assert.strictEqual(R5['유입방식'], 'link', '되돌렸는데 리뷰어에게는 여전히 가이드유입이다');
  assert.ok(R5['상품페이지열기버튼'], '링크유입인데 [상품 페이지 열기]가 없다 — 리뷰어가 상품에 못 간다');

  /* ── 6) 가이드가 빈 선택지가 있는데 가이드유입으로 바꾸려 하면 ──────── */
  DB.options = [{ opt_key: '레드', product_name: '핫팩', status: 'open', pay_amount: 9190,
    recruit_total: 5, daily_limit: 5, option_url: '', unit_kind: 'option',
    inflow_guide_html: '', inflow_guide_images: [] }];
  const beforeWd = JSON.stringify(DB.camp.work_detail);
  DB.wo.source_revision = 3; DB.wo.intake_idempotency_key = 'ro_1:3';
  const B3 = Object.assign({}, BODY, { source_revision: 4, idempotency_key: 'ro_1:4', inflow_type: 'guide', inflow_guide: '' });
  const r5 = mkRes();
  await editHandler({ body: B3, params: { sourceReviewOrderId: 'ro_1' }, headers: {} }, r5, e => { throw e; });
  const R6 = { 저장: r5.statusCode, 전파: r5.body.campaign_inflow_sync,
    공고값_그대로: JSON.stringify(DB.camp.work_detail) === beforeWd };
  console.log('6) 가이드 빈 선택지 → 막힘?', JSON.stringify(R6));
  assert.strictEqual(R6['전파'].applied, false, '가이드가 비었는데 가이드유입으로 바꿔 버렸다');
  assert.strictEqual(R6['전파'].reason, 'guide_missing');
  assert.ok(R6['공고값_그대로'], '거부했는데 공고 값이 바뀌었다 — 되돌리기가 안 됐다');
  assert.ok(/유입가이드/.test(String(R6['전파'].notice || '')),
    '왜 반영이 안 됐는지 사람이 읽을 문장이 없다 — 담당자가 "저장됨" 만 보고 넘어간다');


  console.log('\n  끝까지 이어짐 — 6단계 모두 통과');
  process.exit(0);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
