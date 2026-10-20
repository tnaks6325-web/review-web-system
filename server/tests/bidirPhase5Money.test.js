/**
 * 양방향 5단계(결정 263 · 사용자 확정 D2·D3·2026-10-20 「권장대로」) — 결제금액 · 리뷰비.
 *   ① 요약 문장 이식 = 인트라넷 문장과 글자까지 같다(인트라넷 화면 함수를 직접 돌려 받은 문장 고정)
 *   ② 연결 저장이 여는 경로: 옵션 pay · 옵션 없는 상품 base 중 pay 만 · 리뷰비 / 그 밖(인원·단계)은 그대로 막힌다
 *   ③ 금액 파생(결제합계 차이 · 요약 문장 다시 만들기) · 공고 창 금액 되돌리기(왕복 검사 · 단계 상품 막기 · 창을 연 뒤 바뀐 금액 지키기)
 *   ④ (PGTEST_URL) 진짜 PG + 실제 라우트:
 *      참여 3건(신청 2 · 주문만 1) → 인트라넷이 리뷰비 1000→1500 → 3건 모두 옛 금액 · 새 참여는 새 금액 · 구간 2개 · 보낼 줄
 *      구간 스위치 꺼짐 / 배송유형별 리뷰비 / 예약 구간 → 409 쓰기 0
 *      인트라넷 결제금액 변경 → 공고 옵션 금액 · 금액 이력 · 결제합계 · 요약 문장
 *      금액을 서로 바꾼 공고에서 바꾸기 전 신청자가 옛 금액으로 산 구매 = 잘못구매로 안 걸린다(신청 시각 금액)
 *      공고 창: 리뷰비·옵션 금액 → 오더 · 기간표를 고치면 409 · 창을 연 뒤 바뀐 금액 안 되돌림 · 리뷰어앱/입금관리 리뷰비 막힘
 *      옵션 없는 공고: 상품 안내 금액 치환 / 금액이 여러 개면 409 쓰기 0
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText, regenerateSummary } = require('../src/utils/orderProductSummary');
const SP = require('../src/services/sharedPatch.service');
const { planSharedPatch } = require('../src/utils/sharedPatchPlan');
const E = require('../src/utils/campaignSharedEdit');

const OPT_PRODUCTS = [
  { name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트 대용량' }, label: '화이트 대용량', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] },
  { name: '두번째', url: 'https://smartstore.naver.com/x/products/9', option_schema_version: 2, product_mode: 'none',
    base: { pay: 1234567, count: 3, daily: 1, review_type_mix: [] }, options: [] },
];

// ── ① 요약 문장 = 인트라넷 `reviewOrderProductSummary` 출력(2026-10-20 인트라넷 화면 함수를 vm 으로 돌려 받은 문장) ──
assert.equal(productSummaryText(JSON.stringify(OPT_PRODUCTS)), [
  '[상품/옵션/금액]', '1. 탈취제',
  '- 블랙 / 결제금액 15,900원 / 5명 / 소계 79,500원',
  '- 화이트 대용량 / 결제금액 21,500원 / 12명 / 소계 258,000원',
  '2. 두번째 (https://smartstore.naver.com/x/products/9)',
  '- 결제금액 1,234,567원 / 3명 / 소계 3,703,701원',
  '[합계] 최종모집인원 20명 / 총 상품구입비 4,041,201원'].join('\n'));
assert.equal(productSummaryText(JSON.stringify([{ ...OPT_PRODUCTS[1], qty_tiers: [{ qty: 2, pay: 2000 }] }])), null, '구매수량 단계 = 이식 안 함');
const prevText = productSummaryText(JSON.stringify(OPT_PRODUCTS));
assert.equal(regenerateSummary({ prevJson: JSON.stringify(OPT_PRODUCTS), prevText: prevText + ' (손으로 고침)', nextJson: '[]' }).text, null, '옛 문장이 다르면 안 바꾼다');

// ── ② 쓸 수 있는 경로 ──
{
  const base = { product_options_json: JSON.stringify(OPT_PRODUCTS), review_fee: 1000, title: 'A' };
  const edit = (fn) => { const p = JSON.parse(JSON.stringify(OPT_PRODUCTS)); fn(p); return { ...base, product_options_json: JSON.stringify(p) }; };
  const rows = (mine, origin = 'intranet') => { const pl = planSharedPatch({ base, mine, theirs: base, origin }); return [...pl.writes, ...pl.conflicts]; };
  const okAll = (mine, origin) => rows(mine, origin).every(w => SP.writablePath(w, origin));
  assert.ok(okAll(edit(p => { p[0].options[0].pay = 16900; }), 'intranet'), '옵션 결제금액 = 연다');
  assert.ok(okAll(edit(p => { p[1].base.pay = 1000; }), 'campaign'), '옵션 없는 상품 base 의 pay 만 = 연다');
  assert.ok(!okAll(edit(p => { p[1].base.count = 4; }), 'intranet'), '인원(base.count) = 아직 막힘(7단계)');
  assert.ok(!okAll(edit(p => { p[0].options[0].count = 6; }), 'intranet'), '옵션 인원 = 막힘');
  assert.ok(!okAll(edit(p => { p[1].qty_tiers = [{ qty: 2, pay: 1 }]; }), 'intranet'), '구매수량 단계 = 막힘');
  assert.ok(!okAll(edit(p => { p[0].options.pop(); }), 'intranet'), '옵션 지우기 = 막힘');
  assert.ok(okAll({ ...base, review_fee: 1500 }, 'campaign') && okAll({ ...base, review_fee: 1500 }, 'intranet'), '리뷰비 = 연다');
  assert.deepEqual(planSharedPatch({ base, mine: { ...base, title: 'B' }, theirs: base, origin: 'campaign' }).readOnly.map(r => r.path), ['f:title'], '공고 창발 작업명 = 보기 전용(인트라넷 고유)');

  // applyWrites — 결제금액만 쓰고 주소 반영 표시는 안 한다
  const mine = edit(p => { p[0].options[1].pay = 22500; p[1].base.pay = 1000; });
  const pl = planSharedPatch({ base, mine, theirs: base, origin: 'campaign' });
  const aw = SP.applyWrites(base, mine, pl.writes);
  const got = JSON.parse(aw.next.product_options_json);
  assert.equal(got[0].options[1].pay, 22500); assert.equal(got[1].base.pay, 1000); assert.equal(got[1].base.count, 3, 'base 의 다른 칸은 그대로');
  assert.equal(aw.payTouched, true); assert.equal(aw.urlTouched, false, '금액만 바뀐 저장은 주소를 다시 쓰지 않는다'); assert.deepEqual(aw.missed, []);
  // 결제합계 = 지금 합계 + 차이(1000×12 + (1000-1234567)×3) · 요약 문장 다시 만들기
  const theirs = { ...base, pay_amount: 4041201, product_option: prevText };
  const d = SP.derivePayFields({ base: theirs, theirs, mine, next: aw.next, payProducts: aw.payProducts, origin: 'campaign' });
  assert.equal(d.pay_amount, 4041201 + 1000 * 12 + (1000 - 1234567) * 3);
  assert.equal(d.product_option, productSummaryText(aw.next.product_options_json));
  assert.match(d.product_option, /총 상품구입비 /);
  // 인트라넷발이고 그 사이 리뷰웹이 상품 구성을 안 고쳤으면 인트라넷이 보낸 합계·문장 그대로
  const di = SP.derivePayFields({ base: theirs, theirs, mine: { ...mine, pay_amount: 7, product_option: '인트라넷 문장' }, next: aw.next, payProducts: aw.payProducts, origin: 'intranet' });
  assert.equal(di.pay_amount, 7); assert.equal(di.product_option, undefined);
  // 옛 문장이 이식 문장과 다르면 옛 문장 유지
  const dk = SP.derivePayFields({ base: theirs, theirs: { ...theirs, product_option: '손으로 쓴 문장' }, mine, next: aw.next, payProducts: aw.payProducts, origin: 'campaign' });
  assert.equal(dk.product_option, '손으로 쓴 문장'); assert.equal(dk.summaryKept, 'prev_mismatch');

  // 옵션 금액이 비면 상품 기본 금액(검토 2026-10-20 재현 두 갈래) — 기본 10,000 · 옵션 2개(금액 0 · 각 5명) = 합계 100,000
  const fb = [{ name: '기본금액 상품', url: '', product_mode: 'opt', base: { pay: 10000, count: 0 }, options: [
    { label: 'A', pay: 0, count: 5 }, { label: 'B', pay: 0, count: 5 }] }];
  const fbBase = { product_options_json: JSON.stringify(fb), pay_amount: 100000, product_option: '' };
  const run = (fn) => {
    const m = JSON.parse(JSON.stringify(fb)); fn(m);
    const mineX = { ...fbBase, product_options_json: JSON.stringify(m) };
    const plX = planSharedPatch({ base: fbBase, mine: mineX, theirs: fbBase, origin: 'campaign' });
    const awX = SP.applyWrites(fbBase, mineX, plX.writes);
    return SP.derivePayFields({ base: fbBase, theirs: fbBase, mine: mineX, next: awX.next, payProducts: awX.payProducts, origin: 'campaign' }).pay_amount;
  };
  assert.equal(run(m => { m[0].options[0].pay = 12000; }), 12000 * 5 + 10000 * 5, '옵션 A 만 12,000 → 110,000(나머지는 기본 금액)');
  assert.equal(run(m => { m[0].base.pay = 11000; }), 110000, '옵션 있는 상품의 기본 금액 변경도 합계에 반영');
  // 짝을 못 찾은 쓰기 = missed(호출부가 저장 거부)
  const ghost = SP.applyWrites(base, mine, [{ path: 'p:없는상품|o:X.pay', meta: { kind: 'leaf', key: 'pay', parent: 'p:없는상품|o:X' } }]);
  assert.deepEqual(ghost.missed, ['p:없는상품|o:X.pay']);
}

// ── ③ 공고 창 금액 → 오더 ──
{
  const base = { product_options_json: JSON.stringify(OPT_PRODUCTS), review_fee: 1000, product_option: '' };
  const campOptions = [{ opt_key: '블랙', product_name: '탈취제', unit_kind: 'option', pay_amount: 15900 },
    { opt_key: '화이트 대용량', product_name: '탈취제', unit_kind: 'option', pay_amount: 21500 },
    { opt_key: '두번째', product_name: '두번째', unit_kind: 'product', pay_amount: 1234567 }];
  const bodyOpts = (over = {}) => campOptions.map(o => ({ optKey: o.opt_key, productName: o.product_name, unitKind: o.unit_kind, payAmount: over[o.opt_key] ?? o.pay_amount }));
  let p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { review_fee: 1000, options: bodyOpts() }, campOptions });
  assert.deepEqual(p.mine, {}, '손대지 않음'); assert.deepEqual(p.unmappable, []);
  p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { review_fee: 1500, options: bodyOpts({ '화이트 대용량': 23000, 두번째: 999 }) }, campOptions });
  assert.equal(p.mine.review_fee, 1500);
  const j = JSON.parse(p.mine.product_options_json);
  assert.equal(j[0].options[1].pay, 23000); assert.equal(j[0].options[0].pay, 15900); assert.equal(j[1].base.pay, 999);
  assert.deepEqual(p.changed.sort(), ['결제금액(두번째)', '결제금액(탈취제 / 화이트 대용량)', '리뷰비'].sort());
  const tiered = JSON.parse(JSON.stringify(OPT_PRODUCTS)); tiered[1].qty_tiers = [{ qty: 2, pay: 2000 }];
  p = E.planCampaignMoneyEdit({ baseState: { ...base, product_options_json: JSON.stringify(tiered) }, camp: {}, body: { options: bodyOpts({ 두번째: 999 }) }, campOptions });
  assert.equal(p.unmappable.length, 1, '구매수량 단계 상품 금액은 공고에서 못 바꾼다'); assert.equal(p.mine.product_options_json, undefined);

  // 옵션 없는 공고 — 상품 안내 글의 금액
  const one = [{ name: '단일', url: '', product_mode: 'none', base: { pay: 12000, count: 10 }, options: [] }];
  const b1 = { product_options_json: JSON.stringify(one) };
  const camp = { work_detail: { productLines: '단일 - 결제금액 12,000원' } };
  p = E.planCampaignMoneyEdit({ baseState: b1, camp, body: { work_detail: { productLines: '단일 - 결제금액 13,000원' } }, campOptions: [] });
  assert.equal(JSON.parse(p.mine.product_options_json)[0].base.pay, 13000);
  p = E.planCampaignMoneyEdit({ baseState: b1, camp: { work_detail: { productLines: '단일 - 결제금액 14,000원' } }, body: { work_detail: { productLines: '단일 - 결제금액 12,000원' } }, campOptions: [] });
  assert.equal(p.keepProductLines, true, '창을 연 뒤 리뷰오더에서 바뀐 금액 — 옛 화면 금액으로 안 되돌린다'); assert.deepEqual(p.mine, {});
  p = E.planCampaignMoneyEdit({ baseState: b1, camp, body: { work_detail: { productLines: '단일 - 결제금액 13,000원\n덤 - 결제금액 1,000원' } }, campOptions: [] });
  assert.equal(p.unmappable.length, 1, '금액이 여러 개 = 못 정함');
  p = E.planCampaignMoneyEdit({ baseState: b1, camp: { work_detail: { productLines: '단일 - 결제금액 14,000원' } }, body: { work_detail: { productLines: '단일(새 문장) - 결제금액 12,000원' } }, campOptions: [] });
  assert.equal(p.keepProductLines, false); assert.equal(p.unmappable.length, 1, '창을 연 뒤 금액이 바뀌었는데 다른 문장도 고침 = 새로고침(수정을 조용히 버리지 않는다)');
  // 옵션 이름과 금액을 함께 바꿈 = 못 정함 · 이름만 바꿈 = 통과(금액 공유 대상 아님)
  const renamed = bodyOpts().map(o => (o.optKey === '블랙' ? { ...o, optKey: '블랙2', prevOptKey: '블랙' } : o));
  assert.equal(E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: renamed }, campOptions }).unmappable.length, 0);
  assert.equal(E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: renamed.map(o => (o.optKey === '블랙2' ? { ...o, payAmount: 1 } : o)) }, campOptions }).unmappable.length, 1);
  // 옛 화면(기준 없음) 금액 판정
  assert.deepEqual(E.moneyDriftFromCampaign({ review_fee: 1000 }, { review_fee: 1000 }), []);
  assert.deepEqual(E.moneyDriftFromCampaign({ review_fee: 1000 }, { review_fee: 1200 }), ['리뷰비']);
  assert.deepEqual(E.moneyDriftFromCampaign({}, { options: bodyOpts({ 블랙: 1 }) }, campOptions), ['결제금액']);
}
console.log('bidirPhase5Money: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder, applySharedPatch, readSharedState } = SP;
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const { resolveReviewFee, currentReviewFee, kstDateStr } = require('../src/utils/campaignFee');
  const pv = require('../src/services/productMismatchVerify.service');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
  const scoped = jwt.sign({ id: 'rv_t', role: 'admin', name: '리뷰어관리자', via: 'reviewer_campaign', ia: true, iu: 'u1' }, process.env.JWT_SECRET);
  const admin = { authorization: 'Bearer ' + tok };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const sids = [], camps = [];
  const today = kstDateStr();
  /** 인트라넷 오더 + 발행 그대로인 공고 + 연결. */
  const setup = async (tag, products, extra = {}) => {
    const sid = `ro_p5_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p5_${tag}_${stamp}`; camps.push(camp);
    const json = JSON.stringify(products);
    const payload = {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 5단계 오더 ' + tag, recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/5',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 0, ...extra };
    const r = await call('POST', '/api/order/intake', payload);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail,
         linked_sheet_id, linked_tab_name)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, $12, TRUE, 'active', $13::jsonb, $14, $15)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product }),
        'sheet_p5', `tab_p5_${tag}_${stamp}`]);
    // 발행 폼 규칙: 옵션 모드(opt)일 때만 공고 옵션 줄을 저장한다(단일 상품은 프리필 줄이 있어도 저장 안 함)
    const { _woProductMode } = require('../src/utils/woCampaignPrefill.generated');
    for (const o of (_woProductMode(JSON.parse(JSON.stringify(w))) === 'opt' ? proj.options : [])) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY id', [camp])).rows;
    /** 인트라넷 저장(인트라넷이 보내는 모양: 전 칸 + 다시 계산한 합계·요약 문장). */
    const intranet = async (patch) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷', conflictPolicy: 'last_writer' });
    };
    /** 실제 인트라넷 저장 경로(원본 수정 PUT) — 인트라넷이 하듯 전 칸을 지금 값으로 다시 보내고 바꿀 칸만 덮는다. */
    let rev = 1;
    const putSource = async (patch) => {
      const cur = await wo();
      rev += 1;
      return call('PUT', `/api/order/intake/source/${sid}`, { ...payload, source_revision: rev, idempotency_key: `${sid}:${rev}:p5`,
        product_options_json: cur.product_options_json, product_option: cur.product_option, pay_amount: Number(cur.pay_amount), review_fee: Number(cur.review_fee),
        ...patch, bidir: { base_sync_version: Number(cur.sync_version), op_id: `op_p5_${tag}_${stamp}_${rev}`, ...(patch.__noMoney ? {} : { money: 1 }), ...(patch.__skip ? { skip_products: 1 } : {}) } });
    };
    return { sid, camp, w, wo, cRow, opts, intranet, putSource };
  };
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  const prevSched = process.env.CAMPAIGN_FEE_SCHEDULE;
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    // ═══ 리뷰비 — 참여 3건은 옛 금액, 새 참여는 새 금액 ═══
    const A = await setup('fee', OPT_PRODUCTS);
    const tab = `tab_p5_fee_${stamp}`;
    const app1 = (await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, applied_at) VALUES ($1, '가짜1', '90000001', 'applied', '블랙', NOW() - INTERVAL '3 days') RETURNING id`, [A.camp])).rows[0].id;
    const app2 = (await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, applied_at) VALUES ($1, '가짜2', '90000002', 'applied', '블랙', NOW() - INTERVAL '1 hour') RETURNING id`, [A.camp])).rows[0].id;
    const ord1 = (await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, campaign_application_id, price, submitted_at) VALUES ('sheet_p5', $1, $2, 15900, NOW() - INTERVAL '2 days') RETURNING id`, [tab, app1])).rows[0].id;
    const ord3 = (await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, price, submitted_at) VALUES ('sheet_p5', $1, 21500, NOW() - INTERVAL '1 day') RETURNING id`, [tab])).rows[0].id;
    const snapsOf = async () => ({
      apps: (await pool.query('SELECT id, review_fee_snapshot s FROM campaign_applications WHERE campaign_id = $1 ORDER BY id', [A.camp])).rows.map(r => r.s),
      ords: (await pool.query('SELECT review_fee_snapshot s FROM order_submissions WHERE id = ANY($1::uuid[]) ORDER BY submitted_at', [[ord1, ord3]])).rows.map(r => r.s),
    });
    const sched = async () => (await pool.query(`SELECT to_char(effective_from,'YYYY-MM-DD') "effectiveFrom", review_fee "reviewFee", memo FROM campaign_fee_schedules WHERE campaign_id = $1 ORDER BY effective_from`, [A.camp])).rows;

    // 구간 스위치 꺼짐 → 409 · 쓰기 0
    process.env.CAMPAIGN_FEE_SCHEDULE = '0';
    let r = await A.intranet({ review_fee: 1500 });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'campaign_rejected'); assert.equal(r.body.reason, 'fee_schedule_disabled');
    assert.match(r.body.error, /이미 참여한 분 금액까지/);
    assert.equal(Number((await A.wo()).review_fee), 1000, '오더도 안 바뀐다(통째 되돌림)');
    assert.deepEqual(await snapsOf(), { apps: [null, null], ords: [null, null] });
    if (prevSched === undefined) delete process.env.CAMPAIGN_FEE_SCHEDULE; else process.env.CAMPAIGN_FEE_SCHEDULE = prevSched;

    // 예약 구간 → 409
    await pool.query(`INSERT INTO campaign_fee_schedules (campaign_id, effective_from, review_fee) VALUES ($1, CURRENT_DATE + 30, 3000)`, [A.camp]);
    r = await A.intranet({ review_fee: 1500 });
    assert.equal(r.body.reason, 'fee_future_segment', JSON.stringify(r.body));
    await pool.query('DELETE FROM campaign_fee_schedules WHERE campaign_id = $1', [A.camp]);
    // 배송유형별 리뷰비 → 409
    const mix = JSON.stringify([{ type: 'real', reviewFee: 1000 }, { type: 'empty', reviewFee: 500 }]);
    await pool.query('UPDATE recruit_campaigns SET delivery_review_fee_mix = $2::jsonb WHERE id = $1', [A.camp, mix]);
    r = await A.intranet({ review_fee: 1500 });
    assert.equal(r.body.reason, 'fee_delivery_mix', JSON.stringify(r.body));
    await pool.query(`UPDATE recruit_campaigns SET delivery_review_fee_mix = '[]'::jsonb WHERE id = $1`, [A.camp]);

    // 정상: 1000 → 1500
    r = await A.intranet({ review_fee: 1500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.campaign_applied.includes('review_fee'));
    let c = await A.cRow();
    assert.equal(Number(c.review_fee), 1500); assert.equal(Number((await A.wo()).review_fee), 1500);
    assert.deepEqual(await snapsOf(), { apps: [1000, 1000], ords: [1000, 1000] }, '신청 2 · 주문 2(신청 없는 주문 포함) = 옛 금액 고정');
    const s1 = await sched();
    assert.deepEqual(s1.map(s => [s.effectiveFrom, s.reviewFee]), [['2000-01-01', 1000], [today, 1500]], '바닥 구간(옛 금액) + 오늘부터 새 금액');
    // 판정 단일 출처로 보면: 고정된 3건 = 1000 · 새 참여(오늘) = 1500 · 주문 없는 작업표 줄(어제 날짜) = 1000
    const norm = s1.map(s => ({ effectiveFrom: s.effectiveFrom, reviewFee: s.reviewFee }));
    for (const snap of [...(await snapsOf()).apps, ...(await snapsOf()).ords]) assert.equal(resolveReviewFee({ snapshot: snap, schedules: norm, fallback: 1500 }).fee, 1000);
    assert.equal(currentReviewFee(norm, 1500), 1500, '새 참여 스냅숏(참여 경로가 구간이 있으면 새긴다) = 새 금액');
    const yesterday = kstDateStr(new Date(Date.now() - 86400000));
    assert.equal(resolveReviewFee({ snapshot: null, schedules: norm, fallback: 1500, sheetDate: yesterday }).fee, 1000, '주문 없는 작업표 줄도 날짜로 옛 금액');
    const outbox = (await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1`, [A.w.id])).rows[0].n;
    assert.equal(outbox, 0, '인트라넷발(합쳐짐 없음) = 되돌려 보낼 것 없음');

    // ═══ 결제금액(인트라넷) → 공고 옵션 · 이력 · 합계 · 문장 ═══
    const swapped = JSON.parse((await A.wo()).product_options_json);   // 리뷰웹이 받아 저장한 모양(접수 정규화 뒤) — 인트라넷 저장도 같은 정규화를 거친다
    swapped[0].options[0].pay = 21500; swapped[0].options[1].pay = 15900;   // 블랙 ↔ 화이트 금액을 서로 바꿈
    const swJson = JSON.stringify(swapped);
    r = await A.intranet({ product_options_json: swJson, product_option: productSummaryText(swJson), pay_amount: 21500 * 5 + 15900 * 12 + 1234567 * 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.campaign_applied.includes('pay'), JSON.stringify(r.body));
    const o1 = await A.opts();
    const byKey = new Map(o1.map(o => [o.opt_key, o]));
    assert.equal(Number(byKey.get('블랙').pay_amount), 21500); assert.equal(Number(byKey.get('화이트 대용량').pay_amount), 15900);
    assert.equal(Number(byKey.get('두번째').pay_amount), 1234567, '안 바뀐 줄은 그대로');
    const hist = (await pool.query('SELECT option_id, pay_amount, effective_at FROM campaign_option_price_history WHERE campaign_id = $1 ORDER BY option_id, effective_at', [A.camp])).rows;
    assert.equal(hist.length, 4, '바뀐 두 줄 × (옛 금액 바닥 + 새 금액)');
    let w = await A.wo();
    assert.equal(Number(w.pay_amount), 21500 * 5 + 15900 * 12 + 1234567 * 3, '결제합계 = 인트라넷이 계산해 보낸 값');
    assert.equal(w.product_option, productSummaryText(swJson));

    // 잘못구매 판정 — 바꾸기 전에 블랙을 신청(1시간 전)해 옛 블랙 금액 15,900원으로 산 구매: 지금 금액으로 보면 "화이트 금액" 이라 걸린다
    const held = { verified: true, optionKey: '블랙', campaignId: A.camp };
    const now = await pv.decideAtSubmit({ holdCtx: held, captureText: '', capturePrice: '15900' });
    assert.equal(now.action, 'prompt', '신청 시각이 없으면(종전) 지금 금액으로 = 잘못구매로 묻는다');
    const at = await pv.decideAtSubmit({ holdCtx: { ...held, appliedAt: new Date(Date.now() - 3600000) }, captureText: '', capturePrice: '15900' });
    assert.equal(at.action, 'none', '신청 시각 금액 = 블랙 15,900원 → 정상 구매');
    const after = await pv.decideAtSubmit({ holdCtx: { ...held, appliedAt: new Date() }, captureText: '', capturePrice: '15900' });
    assert.equal(after.action, 'prompt', '바꾼 뒤 신청한 사람이 화이트 금액을 냈으면 그대로 묻는다');

    // 구매수량 단계 상품 금액을 인트라넷에서 바꾸는 것은(단계 칸 자체가 막혀) 저장 거부
    const tiered = JSON.parse(swJson); tiered[1].qty_tiers = [{ qty: 2, pay: 2000 }];
    r = await A.intranet({ product_options_json: JSON.stringify(tiered) });
    assert.equal(r.body.code, 'field_not_editable', JSON.stringify(r.body));

    // ═══ 공고 창 — 리뷰비 · 옵션 금액 → 오더 ═══
    const openEditor = async (camp) => {
      const d = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const cc = d.body.data;
      return { title: cc.title, review_fee: cc.review_fee, max_slots: cc.max_slots, sort_order: cc.sort_order, deadline: cc.deadline,
        work_detail: { ...cc.work_detail }, thumbnail_url: cc.thumbnail_url, time_range: cc.time_range, landing_url: cc.landing_url,
        channel: cc.channel, channel_custom: cc.channel_custom || '',
        window_start: String(cc.window_start || '').slice(0, 5), window_end: String(cc.window_end || '').slice(0, 5),
        // 편집 창이 하듯 상세 응답의 옵션표(camelCase)를 그대로 다시 보낸다
        options: (d.body.options || []).map(o => ({ optKey: o.optKey, productName: o.productName, unitKind: o.unitKind, optionUrl: o.optionUrl, payAmount: o.payAmount,
          recruitTotal: o.recruitTotal, dailyLimit: o.dailyLimit, status: o.status, inflowGuideHtml: o.inflowGuideHtml || '', inflowGuideImages: o.inflowGuideImages || [] })),
        fee_schedules: (d.body.feeSchedules || []).map(s => ({ effectiveFrom: s.effectiveFrom, reviewFee: s.reviewFee, memo: s.memo })),
        bidir_base_sync_version: d.body.bidir ? d.body.bidir.sync_version : undefined };
    };
    const save = (camp, body, headers = admin) => call('PUT', `/api/campaign/admin/${camp}`, body, headers);
    let ed = await openEditor(A.camp);
    assert.ok(ed.bidir_base_sync_version > 0);
    r = await save(A.camp, { ...ed, title: '제목만' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.shared, undefined, '금액·리뷰비 안 고침 = 공유 저장 없음');
    assert.equal((await sched()).length, 2, '기간표 그대로(다시 쓰지 않는다)');

    ed = await openEditor(A.camp);
    r = await save(A.camp, { ...ed, review_fee: 2000, options: ed.options.map(o => (o.optKey === '두번째' ? { ...o, payAmount: 1200000 } : o)) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shared.changed.sort(), ['결제금액(두번째)', '리뷰비'].sort());
    w = await A.wo(); c = await A.cRow();
    assert.equal(Number(w.review_fee), 2000); assert.equal(Number(c.review_fee), 2000);
    assert.equal(JSON.parse(w.product_options_json)[1].base.pay, 1200000, '옵션 없는 상품 = base.pay');
    assert.equal(Number(w.pay_amount), 21500 * 5 + 15900 * 12 + 1200000 * 3, '결제합계 = 차이만큼');
    assert.equal(w.product_option, productSummaryText(w.product_options_json), '요약 문장도 새 금액');
    assert.deepEqual((await sched()).map(s => [s.effectiveFrom, s.reviewFee]), [['2000-01-01', 1000], [today, 2000]], '오늘 구간이 새 금액으로');
    assert.equal(Number((await A.opts()).find(o => o.opt_key === '두번째').pay_amount), 1200000);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1 AND status = 'pending'`, [A.w.id])).rows[0].n, 1, '인트라넷으로 보낼 줄');
    const body = require('../src/services/sharedSyncPush.service').buildPushBody(w);
    for (const k of ['review_fee', 'pay_amount', 'product_options_json', 'product_option']) assert.ok(Object.prototype.hasOwnProperty.call(body.view, k), '보내는 칸: ' + k);

    // 기간표를 고쳐 보내면 409(쓰기 0)
    ed = await openEditor(A.camp);
    r = await save(A.camp, { ...ed, fee_schedules: [], title: '기간표 지움' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'fee_schedule_linked', JSON.stringify(r.body));
    assert.equal((await A.cRow()).title, '제목만', '쓰기 0');

    // 창을 연 뒤 인트라넷이 블랙 금액을 바꿈 → 손대지 않은 창 저장이 옛 금액으로 되돌리지 않는다
    ed = await openEditor(A.camp);
    const pj = JSON.parse((await A.wo()).product_options_json); pj[0].options[0].pay = 25000;
    r = await A.intranet({ product_options_json: JSON.stringify(pj), product_option: productSummaryText(JSON.stringify(pj)) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await save(A.camp, { ...ed, title: '경합 뒤 제목' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await A.opts()).find(o => o.opt_key === '블랙').pay_amount), 25000, '공고 옵션 금액 = 인트라넷 값 유지');
    assert.equal(JSON.parse((await A.wo()).product_options_json)[0].options[0].pay, 25000);

    // 리뷰어앱 스코프 편집 · 입금관리 — 연결 공고 리뷰비는 못 바꾼다(같은 값은 통과)
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { review_fee: 9999 }, { authorization: 'Bearer ' + scoped });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'shared_field_scoped');
    const pay = require('../src/services/payment.service');
    await assert.rejects(pay.saveTransferSetting({ sheetId: 'sheet_p5', tabName: tab, campaignId: A.camp, reviewFee: 9999 }), e => e.code === 'bidir_linked_fee');
    await pay.saveTransferSetting({ sheetId: 'sheet_p5', tabName: tab, campaignId: A.camp, reviewFee: 2000, memo: '가짜입금' });   // 같은 값 = 통과
    assert.equal(Number((await A.cRow()).review_fee), 2000);

    // ═══ 실제 인트라넷 저장 경로 — 리뷰비 변경 · 빈 리뷰비 = 안 바꿈(0원으로 읽지 않는다) ═══
    r = await A.putSource({ review_fee: 2500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await A.cRow()).review_fee), 2500); assert.equal(Number((await A.wo()).review_fee), 2500);
    r = await A.putSource({ review_fee: undefined, special_notes: '리뷰비 칸을 비우고 저장' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await A.wo()).review_fee), 2500, '빈 리뷰비 = 그대로'); assert.equal(Number((await A.cRow()).review_fee), 2500);
    // 금액을 모르는 옛 인트라넷(bidir.money 없음)은 옛 사본 금액을 다시 보낸다 — 금액 칸은 받지 않고 다른 칸만 저장
    r = await A.putSource({ __noMoney: true, review_fee: 1000, special_notes: '옛 인트라넷 저장' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await A.wo()).review_fee), 2500, '옛 인트라넷 저장이 리뷰비를 되돌리지 않는다');
    assert.equal((await A.wo()).special_notes, '옛 인트라넷 저장');
    // 인트라넷 창이 리뷰웹 상품 구성과 짝을 못 지어 금액 칸을 잠근 저장(skip_products) — 옛 사본 금액이 실려 와도 상품 구성은 그대로
    const stalePj = JSON.parse((await A.wo()).product_options_json); stalePj[0].options[0].pay = 1;
    const payBefore = (await A.wo()).product_options_json;
    r = await A.putSource({ __skip: true, product_options_json: JSON.stringify(stalePj), pay_amount: 5, special_notes: '짝 못 지은 창 저장' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await A.wo()).product_options_json, payBefore, '상품 구성(금액) 그대로'); assert.equal((await A.wo()).special_notes, '짝 못 지은 창 저장');
    const sh = await call('GET', `/api/order/intake/source/${A.sid}/shared`);
    assert.ok(sh.body.writable.includes('review_fee'), '인트라넷 수정 창이 리뷰비 잠금을 푼다');

    // ═══ 옵션 없는 공고 — 상품 안내 금액 ═══
    const B = await setup('single', [{ name: '단일상품', url: 'https://www.coupang.com/vp/products/5', option_schema_version: 2, product_mode: 'none',
      base: { pay: 12000, count: 10, daily: 5, review_type_mix: [] }, options: [] }]);
    assert.equal((await B.opts()).length, 0, '옵션 없는 공고');
    const bj = JSON.parse((await B.wo()).product_options_json); bj[0].base.pay = 13000;
    r = await B.intranet({ product_options_json: JSON.stringify(bj), product_option: productSummaryText(JSON.stringify(bj)), pay_amount: 130000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    c = await B.cRow();
    assert.match(c.work_detail.productLines, /결제금액 13,000원/); assert.equal(Number(c.work_detail.payAmount), 13000);
    // 상품 안내에 금액이 여러 개 → 저장 거부(쓰기 0) + 정리 안내
    await pool.query(`UPDATE recruit_campaigns SET work_detail = work_detail || '{"productLines":"단일상품 - 결제금액 13,000원\\n사은품 - 결제금액 1,000원"}'::jsonb WHERE id = $1`, [B.camp]);
    bj[0].base.pay = 14000;
    r = await B.intranet({ product_options_json: JSON.stringify(bj), product_option: productSummaryText(JSON.stringify(bj)), pay_amount: 140000 });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.reason, 'campaign_multiple_amounts');
    assert.match(r.body.error, /모집공고에서 먼저 정리해 주세요/);
    assert.equal(JSON.parse((await B.wo()).product_options_json)[0].base.pay, 13000, '오더도 그대로');
    // 공고 창에서 상품 안내 금액을 고치면 오더로(금액 한 종류일 때)
    await pool.query(`UPDATE recruit_campaigns SET work_detail = work_detail || '{"productLines":"단일상품 - 결제금액 13,000원"}'::jsonb WHERE id = $1`, [B.camp]);
    ed = await openEditor(B.camp);
    r = await save(B.camp, { ...ed, options: [], work_detail: { ...ed.work_detail, productLines: '단일상품 - 결제금액 15,000원' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(JSON.parse((await B.wo()).product_options_json)[0].base.pay, 15000);
    assert.equal(Number((await B.wo()).pay_amount), 150000);
    assert.match((await B.cRow()).work_detail.productLines, /15,000원/);

    console.log('bidirPhase5Money: PG passed');
  } finally {
    if (prevSched === undefined) delete process.env.CAMPAIGN_FEE_SCHEDULE; else process.env.CAMPAIGN_FEE_SCHEDULE = prevSched;
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM order_submissions WHERE sheet_id = $1 AND tab_name LIKE $2', ['sheet_p5', `%_${stamp}`]).catch(() => {});
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_price_history WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_fee_schedules WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1)', [ids]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirPhase5Money: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
