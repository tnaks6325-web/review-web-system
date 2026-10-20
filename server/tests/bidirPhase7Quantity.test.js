/**
 * 양방향 7단계-② 인원·일 진행 건수(결정 263 · 사용자 확정 2026-10-20 「1.권장 2.권장 3.권장 4.권장」).
 *   ① 판정(DB 없음) — 구매수량 단계·배송 혼합은 막힘 · 합계 다름 · 일건수 다름 · 리뷰 혼합 수량 맞춤(같이 바뀌면 통과)
 *   ② 공고 창 인원 → 오더 계획(_planQuantityEdit) — 안 보낸 칸 = 손대지 않음 · 무제한(0)·합계 다름 = 못 담음
 *   ③ (PGTEST_URL) 진짜 PG + 실제 라우트:
 *      인트라넷이 옵션 인원·총모집·일건수를 늘림 → 공고 옵션·총모집·일건수 · 작업표 빈 줄 추가
 *      참여한 사람보다 적게 줄이기 → 409 쓰기 0 · 줄이면 빈 줄만 정리(채워진 줄은 그대로)
 *      합계 다름 → 409 · 인원을 모르는 옛 인트라넷 창(counts 표시 없음) → 인원 칸은 버린다
 *      공고 창 인원 → 오더 상품 구성·총모집 · 연결 공고 차수 추가·제거 → 409
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');
const SP = require('../src/services/sharedPatch.service');

const OPT_PRODUCTS = [
  { name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] },
  { name: '두번째', url: 'https://smartstore.naver.com/x/products/9', option_schema_version: 2, product_mode: 'none',
    base: { pay: 9000, count: 3, daily: 1, review_type_mix: [] }, options: [] },
];

// ── ① 판정 ──
{
  const V = SP.validateQuantities;
  const json = p => JSON.stringify(p);
  const P = JSON.parse(JSON.stringify(OPT_PRODUCTS));
  assert.equal(V({ product_options_json: json(P), recruit_count: 20, daily_count: 4 }, ['탈취제']), null, '합계·일건수가 맞으면 통과');
  assert.equal(V({ product_options_json: json(P), recruit_count: 21, daily_count: 4 }, ['탈취제']).code, 'quantity_sum_mismatch');
  assert.equal(V({ product_options_json: json(P), recruit_count: 20, daily_count: 9 }, ['탈취제']).code, 'quantity_daily_mismatch');
  const T = JSON.parse(JSON.stringify(P)); T[1].qty_tiers = [{ qty: 2, pay: 17000 }];
  assert.equal(V({ product_options_json: json(T), recruit_count: 20 }, ['두번째']).code, 'quantity_tiers_locked', '단계 상품 인원 = 구조 단계까지 막힘');
  assert.equal(V({ product_options_json: json(T), recruit_count: 20, daily_count: 4 }, ['탈취제']), null, '단계 없는 다른 상품은 그대로 바꿀 수 있다');
  assert.equal(V({ product_options_json: json(P), recruit_count: 20, delivery_type_mix: [{ type: 'real', quantity: 10 }, { type: 'empty', quantity: 10 }] }, ['탈취제']).code, 'quantity_delivery_mix_locked');
  // 혼합 리뷰(운영 6건) — 총모집과 혼합 수량이 같이 맞으면 통과, 하나만 바뀌면 막힘
  assert.equal(V({ product_options_json: json(P), recruit_count: 20, daily_count: 4, review_type: '혼합', review_type_mix: [{ type: '포토', quantity: 15 }, { type: '텍스트', quantity: 5 }] }, ['탈취제']), null);
  assert.equal(V({ product_options_json: json(P), recruit_count: 20, daily_count: 4, review_type: '혼합', review_type_mix: [{ type: '포토', quantity: 18 }, { type: '텍스트', quantity: 5 }] }, ['탈취제']).code, 'quantity_mix_mismatch');
  const M = JSON.parse(JSON.stringify(P)); M[0].options[0].review_type_mix = [{ type: '포토', quantity: 3 }, { type: '텍스트', quantity: 1 }];
  assert.equal(V({ product_options_json: json(M), recruit_count: 20, daily_count: 4 }, ['탈취제']).code, 'quantity_mix_mismatch', '옵션 혼합 수량 ≠ 옵션 인원');
  // 판정 행 — 옵션 인원은 옵션이 원래 있고 지금도 있을 때만(더하기·지우기는 구조 단계)
  const row = (key, parent, base, mine) => ({ meta: { kind: 'leaf', key, parent }, base, mine });
  assert.equal(SP.writablePath(row('count', 'p:탈취제|o:블랙', '5', '6'), 'intranet'), true);
  assert.equal(SP.writablePath(row('daily', 'p:탈취제|o:블랙', '1', '2'), 'campaign'), true);
  assert.equal(SP.writablePath(row('count', 'p:탈취제|o:블랙', require('../src/utils/sharedPatchPlan').ABSENT, '6'), 'intranet'), false, '새 옵션 = 구조 단계');
  assert.equal(SP.writablePath({ meta: { kind: 'field', key: 'review_type_mix' }, base: '[{"type":"포토","quantity":5}]', mine: '[{"type":"텍스트","quantity":5}]' }, 'intranet'), false, '유형 구성이 바뀌면 = 구조 단계');
  assert.equal(SP.writablePath({ meta: { kind: 'field', key: 'review_type_mix' }, base: '[{"type":"포토","quantity":5}]', mine: '[{"type":"포토","quantity":7}]' }, 'intranet'), true, '수량만 = 통과');
}

// ── ② 공고 창 인원 → 오더 계획 ──
{
  const E = require('../src/utils/campaignSharedEdit');
  assert.equal(typeof E.planCampaignMoneyEdit, 'function');
  // 안 보낸 인원 칸 = 손대지 않음(인원 칸이 없는 호출이 "0(무제한)으로 바꿨다" 로 읽히던 회귀 · 2026-10-20)
  const live = [{ opt_key: '블랙', recruit_total: 5, daily_limit: 1, pay_amount: 15900, status: 'active' }];
  assert.deepEqual(E.moneyDriftFromCampaign({}, { options: [{ optKey: '블랙', payAmount: 15900 }] }, live), []);
  assert.deepEqual(E.moneyDriftFromCampaign({}, { options: [{ optKey: '블랙', payAmount: 15900, recruitTotal: 7 }] }, live), ['옵션 인원'], '보낸 인원이 다르면 옛 화면은 거부');
  assert.deepEqual(E.moneyDriftFromCampaign({ recruit_total: 20, daily_limit: 4 }, { recruit_total: 22 }), ['총모집']);
}
console.log('bidirPhase7Quantity: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder, applySharedPatch, readSharedState } = SP;
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill, _woProductMode } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const admin = { authorization: 'Bearer ' + jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET) };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const sids = [], camps = [], tabs = [];
  const SHEET = 'sheet_p7q';
  /** 인트라넷 오더 + 발행 그대로인 공고(무시트 작업표 줄 = 총모집) + 연결. */
  const setup = async (tag, products, extra = {}) => {
    const sid = `ro_p7q_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7q_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7q_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(products);
    const payload = {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 인원 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/7',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 15900 * 5 + 21500 * 12 + 9000 * 3, ...extra };
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
        SHEET, tab]);
    for (const o of (_woProductMode(JSON.parse(JSON.stringify(w))) === 'opt' ? proj.options : [])) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    // 무시트 작업표 — 총모집만큼 줄(앞 2줄은 참여자가 채운 줄)
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless, updated_at) VALUES ($1, $2, TRUE, NOW())`, [SHEET, tab]);
    for (let i = 1; i <= Number(proj.recruit_total); i++) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, reviewer_name, source, updated_by, updated_at)
                        VALUES ($1, $2, $3, '{}'::jsonb, $4, 'worktable', '시험', NOW())`, [SHEET, tab, i, i <= 2 ? '가짜참여' + i : null]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => new Map((await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY id', [camp])).rows.map(o => [o.opt_key, o]));
    const rows = async () => (await pool.query(`SELECT seq, reviewer_name FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active ORDER BY seq`, [SHEET, tab])).rows;
    /** 인트라넷 저장(전 칸 + 바꿀 칸 · 인원을 아는 창). */
    const intranet = async (patch, { counts = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: counts });
    };
    return { sid, camp, tab, w, wo, cRow, opts, rows, intranet };
  };
  /** 인트라넷 화면이 하듯 상품 구성을 고치고 총모집·일건수·결제합계·요약 문장을 다시 계산한다. */
  const edited = (cur, fn) => {
    const p = JSON.parse(cur.product_options_json); fn(p);
    let total = 0, daily = 0, pay = 0;
    for (const x of p) {
      if (x.options.length) for (const o of x.options) { total += o.count; daily += o.daily; pay += o.pay * o.count; }
      else { total += x.base.count; daily += x.base.daily; pay += x.base.pay * x.base.count; }
    }
    const json = JSON.stringify(p);
    return { product_options_json: json, recruit_count: total, daily_count: daily, pay_amount: pay, product_option: productSummaryText(json) };
  };
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    const A = await setup('opt', OPT_PRODUCTS);
    assert.equal((await A.rows()).length, 20);
    for (let k = 0; k < 4; k++) {
      await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at) VALUES ($1, $2, $3, 'applied', '블랙', NOW() + INTERVAL '1 hour')`,
        [A.camp, '가짜' + k, '7200000' + k]);
    }

    // ═══ 늘리기 — 화이트 12→15 · 일 2→3 ═══
    let r = await A.intranet(edited(await A.wo(), p => { p[0].options[1].count = 15; p[0].options[1].daily = 3; }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.campaign_applied || []).includes('quantity'), JSON.stringify(r.body));
    let c = await A.cRow(), o = await A.opts(), w = await A.wo();
    assert.equal(Number(c.recruit_total), 23); assert.equal(Number(c.daily_limit), 5);
    assert.equal(Number(o.get('화이트').recruit_total), 15); assert.equal(Number(o.get('화이트').daily_limit), 3);
    assert.equal(Number(o.get('블랙').recruit_total), 5, '안 바뀐 옵션 그대로');
    assert.equal(Number(w.recruit_count), 23); assert.equal(Number(w.daily_count), 5);
    assert.equal(Number(w.pay_amount), 15900 * 5 + 21500 * 15 + 9000 * 3, '결제합계 = 금액 × 바뀐 인원');
    assert.equal((await A.rows()).length, 23, '작업표 빈 줄 3줄 추가');

    // ═══ 참여한 사람보다 적게 — 블랙 4명 참여 중 5→3 ═══
    const v0 = Number((await A.wo()).sync_version);
    r = await A.intranet(edited(await A.wo(), p => { p[0].options[0].count = 3; }));
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.reason, 'option_below_used', JSON.stringify(r.body));
    assert.match(r.body.error, /이미 4명이 참여/);
    assert.equal(Number((await A.wo()).recruit_count), 23, '오더도 그대로(통째 되돌림)'); assert.equal(Number((await A.wo()).sync_version), v0);
    assert.equal(Number((await A.opts()).get('블랙').recruit_total), 5);

    // ═══ 줄이기 — 화이트 15→10 → 빈 줄만 정리 ═══
    r = await A.intranet(edited(await A.wo(), p => { p[0].options[1].count = 10; }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rs = await A.rows();
    assert.equal(rs.length, 18); assert.equal(rs.filter(x => x.reviewer_name).length, 2, '참여자가 채운 줄은 그대로');
    assert.equal(Number((await A.cRow()).recruit_total), 18);

    // ═══ 합계 다름 → 409 쓰기 0 ═══
    r = await A.intranet({ recruit_count: 30 });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'quantity_sum_mismatch', JSON.stringify(r.body));
    assert.equal(Number((await A.wo()).recruit_count), 18);

    // ═══ 인원을 모르는 옛 인트라넷 창 → 인원 칸은 버린다(다른 칸은 저장) ═══
    r = await A.intranet({ ...edited(await A.wo(), p => { p[0].options[1].count = 14; }), special_notes: '옛 창 저장' }, { counts: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    w = await A.wo();
    assert.equal(Number(w.recruit_count), 18, '옛 창의 인원(옛 사본일 수 있다)은 받지 않는다'); assert.equal(w.special_notes, '옛 창 저장');
    assert.equal(JSON.parse(w.product_options_json)[0].options[1].count, 10);

    // ═══ 공고 창 인원 → 오더 ═══
    const d = await call('GET', `/api/campaign/admin/${A.camp}`, null, admin);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const cc = d.body.data;
    const body = { title: cc.title, review_fee: cc.review_fee, max_slots: cc.max_slots, sort_order: cc.sort_order, deadline: cc.deadline,
      work_detail: { ...cc.work_detail }, thumbnail_url: cc.thumbnail_url, time_range: cc.time_range, landing_url: cc.landing_url,
      channel: cc.channel, channel_custom: cc.channel_custom || '', window_start: String(cc.window_start || '').slice(0, 5), window_end: String(cc.window_end || '').slice(0, 5),
      recruit_total: cc.recruit_total, daily_limit: cc.daily_limit,
      options: (d.body.options || []).map(x => ({ optKey: x.optKey, productName: x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
        recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
      fee_schedules: (d.body.feeSchedules || []).map(s => ({ effectiveFrom: s.effectiveFrom, reviewFee: s.reviewFee, memo: s.memo })),
      bidir_base_sync_version: d.body.bidir ? d.body.bidir.sync_version : undefined };
    assert.ok(body.bidir_base_sync_version > 0);
    const white = body.options.find(x => x.optKey === '화이트');
    white.recruitTotal = 11; body.recruit_total = 19;
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, body, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    w = await A.wo();
    assert.equal(Number(w.recruit_count), 19, '오더 총모집'); assert.equal(JSON.parse(w.product_options_json)[0].options[1].count, 11, '오더 옵션 인원');
    assert.equal(Number((await A.opts()).get('화이트').recruit_total), 11); assert.equal(Number((await A.cRow()).recruit_total), 19);
    assert.equal((await A.rows()).length, 19, '공고 창 저장도 작업표 줄을 맞춘다');
    // 공고 창: 총모집 ≠ 옵션 합계 → 오더에 못 담음(409 · 쓰기 0)
    const d2 = await call('GET', `/api/campaign/admin/${A.camp}`, null, admin);
    const body2 = { ...body, recruit_total: 25, options: body.options.map(x => ({ ...x })), bidir_base_sync_version: d2.body.bidir.sync_version };
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, body2, admin);
    assert.ok(r.status === 409 || r.body.ok === false || r.body.error, '합계 다름 = 못 담음: ' + JSON.stringify(r.body));
    assert.equal(Number((await A.cRow()).recruit_total), 19, '쓰기 0'); assert.equal(Number((await A.wo()).recruit_count), 19);

    // ═══ 검토 2026-10-21 ① 관리자 오더 수정(상품 구성 + 총모집) → 공고 옵션 인원이 오더와 같다(다시 나누지 않는다) ═══
    {
      const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
      const cur = await A.wo();
      const e = edited(cur, p => { p[0].options[0].count = 7; });
      r = await call('PUT', '/api/order/admin/edit', { id: A.w.id, product_options_json: e.product_options_json, recruit_count: e.recruit_count }, { authorization: 'Bearer ' + tok });
      if (r.status === 401 || r.status === 403) console.log('  - 관리자 수정: 시험 토큰 거부로 건너뜀');
      else {
        assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
        const oo = await A.opts();
        assert.equal(Number(oo.get('블랙').recruit_total), 7); assert.equal(Number(oo.get('화이트').recruit_total), 11, '다른 옵션을 비율로 다시 나누지 않는다');
        assert.equal(Number((await A.cRow()).recruit_total), 21); assert.equal((await A.rows()).length, 21);
        assert.equal(Number((await A.wo()).recruit_count), 21);
      }
    }
    const openBody = async (camp) => {
      const dd = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
      const c0 = dd.body.data;
      return { title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
        work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
        channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
        recruit_total: c0.recruit_total, daily_limit: c0.daily_limit,
        options: (dd.body.options || []).map(x => ({ optKey: x.optKey, productName: x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
          recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
        fee_schedules: (dd.body.feeSchedules || []).map(x => ({ effectiveFrom: x.effectiveFrom, reviewFee: x.reviewFee, memo: x.memo })),
        bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined };
    };
    const snapA = async () => JSON.stringify([Number((await A.wo()).recruit_count), Number((await A.cRow()).recruit_total), Number((await A.cRow()).daily_limit), [...(await A.opts()).values()].map(o => `${o.opt_key}:${o.recruit_total}/${o.daily_limit}`)]);
    // ② 이름과 인원을 함께 바꿈 → 409 쓰기 0
    let s0 = await snapA();
    let eb = await openBody(A.camp);
    eb.options = eb.options.map(x => x.optKey === '화이트' ? { ...x, optKey: '화이트2', prevOptKey: '화이트', recruitTotal: 13 } : x);
    eb.recruit_total = Number(eb.recruit_total) + 2;
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.ok(r.status === 409 || r.body.ok === false, '이름+인원 = 못 담음: ' + JSON.stringify(r.body));
    assert.equal(await snapA(), s0, '쓰기 0');
    // ③ 일 진행 건수만(옵션 일건수 그대로) → 409(종전: "저장됨" 인데 아무 데도 안 바뀜)
    eb = await openBody(A.camp); eb.daily_limit = Number(eb.daily_limit) + 3;
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.ok(r.status === 409 || r.body.ok === false, '일건수만 = 못 담음: ' + JSON.stringify(r.body));
    assert.equal(await snapA(), s0);
    // ④ 연결 저장 스위치가 꺼져 있어도 인원은 공유 칸 — 공고 창·리뷰어앱·차수 모두 막힘(버전 없이 오더 총모집이 바뀌던 길)
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    eb = await openBody(A.camp); eb.recruit_total = Number(eb.recruit_total) + 1;
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'counts_link_paused');
    eb = await openBody(A.camp); eb.options = eb.options.map(x => x.optKey === '블랙' ? { ...x, recruitTotal: 8 } : x);
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.body.code, 'counts_link_paused', '옵션 인원도: ' + JSON.stringify(r.body));
    const scoped = { authorization: 'Bearer ' + jwt.sign({ id: 'rv_t', role: 'admin', name: '리뷰어관리자', via: 'reviewer_campaign', ia: true, iu: 'u1' }, process.env.JWT_SECRET) };
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { recruit_total: 30 }, scoped);
    assert.ok(r.status === 409 || r.body.ok === false, '리뷰어앱 총모집: ' + JSON.stringify(r.body));
    r = await call('POST', `/api/trackb/campaigns/${A.camp}/rounds`, { count: 5 }, admin);
    if (r.status !== 401 && r.status !== 403) assert.equal(r.body.code, 'rounds_bidir_linked', '스위치 꺼져도 차수 막힘: ' + JSON.stringify(r.body));
    assert.equal(await snapA(), s0, '스위치 꺼짐 — 인원 쓰기 0');
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    // ═══ 연결 공고 차수 추가·제거 → 409 ═══
    r = await call('POST', `/api/trackb/campaigns/${A.camp}/rounds`, { count: 5 }, admin);
    if (r.status === 401 || r.status === 403) {
      console.log('  - 차수 라우트: 시험 토큰이 거부돼 건너뜀(' + r.status + ')');
    } else {
      assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'rounds_bidir_linked', JSON.stringify(r.body));
      r = await call('DELETE', `/api/trackb/campaigns/${A.camp}/rounds`, null, admin);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(Number((await A.cRow()).recruit_total), 21, '차수 막힘 = 총모집 그대로(위 관리자 수정 뒤 21)');
    }

    // ═══ 옵션 없는 공고(단일 상품) — 인트라넷 base 인원 → 공고 총모집·작업표 ═══
    const single = [{ name: '단일상품', url: '', option_schema_version: 2, product_mode: 'none', base: { pay: 13000, count: 20, daily: 4, review_type_mix: [] }, options: [] }];
    const B = await setup('single', single, { pay_amount: 13000 * 20 });
    r = await B.intranet(edited(await B.wo(), p => { p[0].base.count = 24; }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await B.cRow()).recruit_total), 24); assert.equal((await B.rows()).length, 24);
    assert.equal(Number((await B.wo()).pay_amount), 13000 * 24);

    // ═══ 검토 2026-10-21 ⑤ 상품 구성 없는 오더 — 공고 창 총모집 → 오더 총모집·작업표(종전: 저장됨인데 아무 데도 안 바뀜) ═══
    const C = await setup('noprod', [], { product_options_json: undefined, product_option: '', pay_amount: 0 });
    const ec = await openBody(C.camp);
    assert.ok(ec.bidir_base_sync_version > 0);
    ec.recruit_total = 22;
    r = await call('PUT', `/api/campaign/admin/${C.camp}`, ec, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.equal(Number((await C.wo()).recruit_count), 22); assert.equal(Number((await C.cRow()).recruit_total), 22); assert.equal((await C.rows()).length, 22);

    console.log('bidirPhase7Quantity: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_participants WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_plan_events WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
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
  console.log('bidirPhase7Quantity: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
