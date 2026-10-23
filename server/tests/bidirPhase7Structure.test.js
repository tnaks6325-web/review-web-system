/**
 * 양방향 7단계-④ 구조(결정 274 · 사용자 확정 2026-10-21 「1.가 2.가 3.가 4.가」 + 「가로 하고 인트라넷에도 그냥 보이게」).
 *   ① 새는 틈 막기 — 판정(`structureChangesFromCampaign`): 옵션 더하기·지우기·이름·마감, 상품 이름·방식, 배송 방식, 리뷰타입 종류, 체험단 종류.
 *      접수 뒤 영구 금지(체험단 종류·배송 혼합·회수) = permanent. 수량(인원·혼합 수량)은 7단계-② 몫이라 보지 않는다.
 *   ② 상품·옵션 더하기·지우기 — 공유 저장(오더 → 공고 줄 → 작업표 빈 줄)으로. 참여자가 있는 줄을 지우면 마감(closed:true · 인원 = 참여 수)으로 남는다.
 *   (PGTEST_URL) 실제 라우트·공유 저장: 공고 창 더하기·지우기·마감·다시 열기 · 인트라넷 더하기·지우기(마감) · 옛 창 막힘 ·
 *      리뷰타입 섞어 쓰기 마감 거부 · 다른 상품 같은 옵션 이름 거부 · 지운 옵션의 빈 작업표 줄 비우기·먼저 정리 ·
 *      아직 막힌 구조 변경 409 · 리뷰어앱 배송 409 · 합치기 409 · 연결 안 된 공고는 종전대로.
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');
const E = require('../src/utils/campaignSharedEdit');

const OPT_PRODUCTS = [
  { name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] },
  { name: '두번째', url: 'https://smartstore.naver.com/x/products/9', option_schema_version: 2, product_mode: 'none',
    base: { pay: 9000, count: 3, daily: 1, review_type_mix: [] }, options: [] },
];

{
  const S = (camp, store, normOpts, campOptions) => E.structureChangesFromCampaign({ camp, store, normOpts, campOptions })
    .map(x => x.label + (x.permanent ? '!' : ''));
  const camp = { delivery_type: '실배송', review_type: 'photo', work_kind: '', delivery_type_mix: [], review_type_mix: [] };
  const rows = [
    { opt_key: '블랙', product_name: '탈취제', unit_kind: 'option', status: 'active' },
    { opt_key: '화이트', product_name: '탈취제', unit_kind: 'option', status: 'active' },
    { opt_key: '두번째', product_name: '두번째', unit_kind: 'product', status: 'active' },
  ];
  const sent = () => rows.map(r => ({ optKey: r.opt_key, prevOptKey: r.opt_key, productName: r.product_name, unitKind: r.unit_kind, status: 'active' }));
  // 같은 값 = 구조 변경 없음(빈 값·별칭 포함)
  assert.deepEqual(S(camp, { delivery_type: '실배송', review_type: '포토', work_kind: 'review' }, sent(), rows), []);
  assert.deepEqual(S({ ...camp, review_type: null }, { review_type: '자율리뷰' }, null, rows), [], '자율리뷰 = 지정 안 함 = 빈 값');
  assert.deepEqual(S(camp, {}, null, rows), [], '안 보낸 칸 = 유지');
  // 옵션 구성
  assert.deepEqual(S(camp, {}, [...sent(), { optKey: '그레이', prevOptKey: '', productName: '탈취제', unitKind: 'option', status: 'active' }], rows), ['옵션·상품 추가']);
  assert.deepEqual(S(camp, {}, sent().filter(o => o.optKey !== '블랙'), rows), ['옵션·상품 삭제']);
  assert.deepEqual(S(camp, {}, sent().map(o => (o.optKey === '블랙' ? { ...o, optKey: '블랙2' } : o)), rows), ['옵션·상품 이름'], '원래 이름(prevOptKey)이 있으면 이름 바꾸기');
  assert.deepEqual(S(camp, {}, sent().map(o => (o.optKey === '블랙' ? { ...o, optKey: '블랙2', prevOptKey: '' } : o)), rows), ['옵션·상품 추가', '옵션·상품 삭제'], '원래 이름 없음 = 지우고 더하기');
  assert.deepEqual(S(camp, {}, sent().map(o => (o.optKey === '블랙' ? { ...o, productName: '방향제' } : o)), rows), ['상품 이름']);
  assert.deepEqual(S(camp, {}, sent().map(o => (o.optKey === '두번째' ? { ...o, unitKind: 'option' } : o)), rows), ['상품 방식(옵션 있음·없음)']);
  assert.deepEqual(S(camp, {}, sent().map(o => (o.optKey === '블랙' ? { ...o, status: 'closed' } : o)), rows), ['옵션 마감·다시 열기']);
  assert.deepEqual(S(camp, {}, sent().map(o => ({ ...o, status: null })), rows), [], '마감 상태를 안 보냄 = 유지');
  assert.deepEqual(S(camp, {}, [], []), [], '옵션 없는 공고가 옵션 없이 저장');
  // 배송 — 한 종류끼리는 나중에 열린다, 혼합·회수가 끼면 영구 금지
  assert.deepEqual(S(camp, { delivery_type: '빈박스' }), ['배송 방식']);
  assert.deepEqual(S(camp, { delivery_type: '혼합', delivery_type_mix: [{ type: 'real', quantity: 5 }, { type: 'empty', quantity: 15 }] }), ['배송 방식!']);
  assert.deepEqual(S({ ...camp, delivery_type: '회수' }, { delivery_type: '실배송', recall_courier: '', recall_product: '' }), ['배송 방식!']);
  assert.deepEqual(S({ ...camp, delivery_type: '혼합', delivery_type_mix: [{ type: 'real', quantity: 5 }, { type: 'empty', quantity: 15 }] },
    { delivery_type: '혼합', delivery_type_mix: [{ type: 'real', quantity: 6 }, { type: 'empty', quantity: 14 }] }), ['배송 혼합!']);
  assert.deepEqual(S({ ...camp, delivery_type: '회수', recall_courier: 'A택배' }, { delivery_type: '회수', recall_courier: 'B택배' }), ['회수 정보!']);
  assert.deepEqual(S({ ...camp, delivery_type_mix: [{ type: 'real', quantity: 5 }] }, { delivery_type: '실배송', delivery_type_mix: [], recall_courier: '' }), [],
    '기본형이 아니면 남아 있던 옛 부속정보와 비교하지 않는다');
  // 리뷰타입 — 종류만
  assert.deepEqual(S(camp, { review_type: '텍스트' }), ['리뷰타입']);
  const mixed = { ...camp, review_type: 'mixed', review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] };
  assert.deepEqual(S(mixed, { review_type: 'mixed', review_type_mix: [{ type: 'photo', quantity: 12 }, { type: 'text', quantity: 8 }] }), [], '수량만 = 7단계-② 몫');
  assert.deepEqual(S(mixed, { review_type: 'mixed', review_type_mix: [{ type: 'photo', quantity: 12 }, { type: 'star', quantity: 8 }] }), ['리뷰타입'], '섞는 종류가 바뀜');
  assert.deepEqual(S(mixed, { review_type: '포토', review_type_mix: [] }), ['리뷰타입']);
  assert.deepEqual(S({ ...camp, review_type_mix: [{ type: 'photo', quantity: 3 }] }, { review_type: '포토', review_type_mix: [] }), [], '섞어 쓰기가 아니면 옛 혼합 값과 비교하지 않는다');
  // 체험단 종류
  assert.deepEqual(S(camp, { work_kind: 'blog' }), ['체험단 종류!']);
  assert.deepEqual(S({ ...camp, work_kind: 'review' }, { work_kind: '' }), [], '빈 값 = 리뷰');
}
console.log('bidirPhase7Structure: static passed');

{
  // ② 판정 — 쓰기 가능 경로(더하기·지우기·덮인 칸·마감 줄·다시 열기)
  const SP = require('../src/services/sharedPatch.service');
  const { planSharedPatch, ABSENT } = require('../src/utils/sharedPatchPlan');
  const P = JSON.stringify(OPT_PRODUCTS);
  const base = { product_options_json: P, recruit_count: 20 };
  const withOpt = (fn) => { const x = JSON.parse(P); fn(x); return JSON.stringify(x); };
  const add = withOpt(x => x[0].options.push({ option_1: { name: '', value: '그레이' }, label: '그레이', url: '', pay: 1000, count: 4, daily: 1, review_type_mix: [] }));
  const del = withOpt(x => x[0].options.splice(0, 1));
  const run = (mine, origin = 'intranet', cap = true) => {
    const plan = planSharedPatch({ base, mine, theirs: base, origin });
    SP.markStructureRows(plan, base, mine, { structureCapable: cap });
    return { plan, blocked: plan.writes.filter(w => !SP.writablePath(w, origin)).map(w => w.path) };
  };
  let r = run({ ...base, product_options_json: add, recruit_count: 24 });
  assert.deepEqual(r.blocked, [], '옵션 더하기 = 쓸 수 있음(안의 칸은 덮인 칸)');
  assert.ok(r.plan.writes.some(w => w.path === 'p:탈취제|o:그레이' && w.base === ABSENT));
  r = run({ ...base, product_options_json: add, recruit_count: 24 }, 'intranet', false);
  assert.ok(r.blocked.includes('p:탈취제|o:그레이'), '구조를 모르는 옛 인트라넷 창 = 막힘');
  r = run({ ...base, product_options_json: del, recruit_count: 15 });
  assert.deepEqual(r.blocked, [], '옵션 지우기 = 쓸 수 있음');
  r = run({ ...base, product_options_json: add, recruit_count: 24 }, 'rw_admin');
  assert.ok(r.blocked.length, '관리자 오더 수정 창은 아직 구조를 못 바꾼다');
  // 마감 줄 — 칸은 못 고치고, 다시 열기(마감 표시 떼기)는 된다
  const closedP = withOpt(x => { x[0].options[0] = { ...x[0].options[0], closed: true, count: 3, daily: 0 }; });
  const cbase = { product_options_json: closedP, recruit_count: 18 };
  const cplan = (mineJson, rc) => { const mine = { ...cbase, product_options_json: mineJson, recruit_count: rc };
    const plan = planSharedPatch({ base: cbase, mine, theirs: cbase, origin: 'intranet' }); SP.markStructureRows(plan, cbase, mine);
    return plan.writes.filter(w => !SP.writablePath(w, 'intranet')).map(w => w.path); };
  assert.deepEqual(cplan(JSON.stringify(JSON.parse(closedP).map((p, i) => (i ? p : { ...p, options: p.options.map((o, j) => (j ? o : { ...o, count: 9 })) }))), 24), ['p:탈취제|o:블랙.count'], '마감 줄 인원은 못 고친다');
  const reopened = JSON.parse(closedP); delete reopened[0].options[0].closed; reopened[0].options[0].count = 6; reopened[0].options[0].daily = 1;
  assert.deepEqual(cplan(JSON.stringify(reopened), 21), [], '다시 열기(마감 표시 떼기 + 인원) = 쓸 수 있음');
  // 적용 — 더하기·지우기·다시 열기
  let a = SP.applyWrites(base, { ...base, product_options_json: add }, run({ ...base, product_options_json: add }).plan.writes);
  assert.equal(JSON.parse(a.next.product_options_json)[0].options.map(o => o.label).join(','), '블랙,화이트,그레이');
  assert.deepEqual(a.structure.addedOptions, [{ pName: '탈취제', oLabel: '그레이' }]); assert.equal(a.missed.length, 0);
  a = SP.applyWrites(base, { ...base, product_options_json: del }, run({ ...base, product_options_json: del }).plan.writes);
  assert.equal(JSON.parse(a.next.product_options_json)[0].options.map(o => o.label).join(','), '화이트');
  assert.equal(a.structure.removedOptions[0].oLabel, '블랙'); assert.equal(a.structure.removedOptions[0].index, 0);
  const delProd = withOpt(x => x.splice(1, 1));
  a = SP.applyWrites(base, { ...base, product_options_json: delProd }, run({ ...base, product_options_json: delProd }).plan.writes);
  assert.equal(JSON.parse(a.next.product_options_json).length, 1); assert.equal(a.structure.removedProducts[0].pName, '두번째');
  // 투영 모양 — 마감 = status 'closed' (연결 판정이 마감 차이를 다름으로 센다)
  const { projectOrderToCampaign, compareOrderCampaign, unitClosedFlags } = require('../src/utils/orderToCampaignProjection');
  assert.deepEqual(unitClosedFlags(closedP), [true, false, false]);
  assert.equal(projectOrderToCampaign({ product_options_json: closedP }).options[0].status, 'closed');
  const rowsOf = (st) => [{ opt_key: '블랙', product_name: '탈취제', unit_kind: 'option', status: st, pay_amount: 15900, recruit_total: 3, daily_limit: 0, review_type_mix: [] }];
  const one = JSON.stringify([{ ...JSON.parse(closedP)[0], options: [JSON.parse(closedP)[0].options[0]] }]);
  assert.ok(compareOrderCampaign({ product_options_json: one }, {}, rowsOf('active')).some(d => /status/.test(d.field)), '오더 마감 · 공고 살아 있음 = 다름');
  assert.ok(!compareOrderCampaign({ product_options_json: one }, {}, rowsOf('closed')).some(d => /status/.test(d.field)));
}
console.log('bidirPhase7Structure: static ② passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const SP = require('../src/services/sharedPatch.service');
  const { linkSharedOrder, applySharedPatch, readSharedState } = SP;
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const admin = { authorization: 'Bearer ' + jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET) };
  const scoped = { authorization: 'Bearer ' + jwt.sign({ id: 'rv_t', role: 'admin', name: '리뷰어관리자', via: 'reviewer_campaign', ia: true, iu: 'u1' }, process.env.JWT_SECRET) };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const sids = [], camps = [], tabs = [];
  const SHEET = 'sheet_p7s';
  /** 인트라넷 오더 + 발행 그대로인 공고(옵션 줄) + 무시트 작업표(총모집만큼 빈 줄, 옵션 배정 표식) + 연결(link=false 면 연결 안 함). */
  const setup = async (tag, { link = true, extra = {} } = {}) => {
    const sid = `ro_p7s_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7s_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7s_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(OPT_PRODUCTS);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 구조 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/7',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 15900 * 5 + 21500 * 12 + 9000 * 3, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail,
         linked_sheet_id, linked_tab_name, linked_tab_gid)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', FALSE, $8, '', $9, $10, $11, TRUE, 'active', $12::jsonb, $13, $14, '7')`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product }),
        SHEET, tab]);
    for (const o of proj.options) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    // 무시트 작업표 — 접수 때처럼 옵션 배정 표식을 붙인다(블랙 5 · 화이트 12 · 두번째 3)
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless, updated_at) VALUES ($1, $2, TRUE, NOW())`, [SHEET, tab]);
    const labels = [...Array(5).fill('블랙'), ...Array(12).fill('화이트'), ...Array(3).fill('두번째')];
    for (let i = 1; i <= labels.length; i++) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, option_text, source, updated_by, updated_at)
                        VALUES ($1, $2, $3, $4::jsonb, $5, 'worktable', '시험', NOW())`, [SHEET, tab, i, JSON.stringify({ 옵션: labels[i - 1] }), labels[i - 1]]);
    }
    if (link) {
      await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
      const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
      assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    }
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => new Map((await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY id', [camp])).rows.map(o => [o.opt_key, o]));
    const rows = async () => (await pool.query(`SELECT id, seq, option_text, row_json, reviewer_name FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active ORDER BY seq`, [SHEET, tab])).rows;
    const prods = async () => JSON.parse((await wo()).product_options_json);
    const snap = async () => {
      const c = (await pool.query('SELECT delivery_type, review_type, work_kind, delivery_type_mix, recruit_total FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
      const o = (await pool.query('SELECT opt_key, product_name, unit_kind, status, recruit_total FROM campaign_options WHERE campaign_id = $1 ORDER BY opt_key', [camp])).rows;
      const x = (await pool.query('SELECT sync_version, product_options_json, delivery_type, recruit_count FROM work_orders WHERE id = $1', [w.id])).rows[0];
      return JSON.stringify([c, o, x, (await rows()).length]);
    };
    let phoneSeq = 0;
    const apply = (n) => { const from = phoneSeq; phoneSeq += n.count;
      return pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at)
        SELECT $1, '가짜참여' || g, lpad((7200000 + $4 + g)::text, 8, '0'), 'applied', $2, NOW() + INTERVAL '1 hour' FROM generate_series(1, $3) g`, [camp, n.key, n.count, from]); };
    /** 인트라넷 저장(전 칸 + 바꿀 칸). */
    const intranet = async (patch, { structure = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: structure });
    };
    return { sid, camp, tab, w, wo, cRow, opts, rows, prods, snap, apply, intranet };
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
  const openBody = async (camp) => {
    const dd = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
    const c0 = dd.body.data;
    return { title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
      work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
      channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
      // 공고 창 진행상품 표 규칙 — 총모집·일건수는 열린 줄 합계(하나라도 0 이면 0) · 옵션 줄 없는 공고는 공고 값
      ...(() => { const live = (dd.body.options || []).filter(x => x.status !== 'closed');
        if (!live.length) return { recruit_total: c0.recruit_total, daily_limit: c0.daily_limit };
        const s2 = k => (live.every(x => Number(x[k]) > 0) ? live.reduce((a, x) => a + Number(x[k]), 0) : 0);
        return { recruit_total: s2('recruitTotal'), daily_limit: s2('dailyLimit') }; })(),
      delivery_type: c0.delivery_type, review_type: c0.review_type, work_kind: c0.work_kind || 'review',
      options: (dd.body.options || []).map(x => ({ optKey: x.optKey, prevOptKey: x.optKey, productName: x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
        recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
      fee_schedules: (dd.body.feeSchedules || []).map(x => ({ effectiveFrom: x.effectiveFrom, reviewFee: x.reviewFee, memo: x.memo })),
      bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined };
  };
  // 공고 창 진행상품 표와 같은 규칙 — 총모집·일건수는 열린 줄만 더한다(마감 줄 제외)
  const sum = (b, k) => b.options.filter(o => o.status !== 'closed').reduce((a, o) => a + Number(o[k] || 0), 0);
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    const A = await setup('a');
    const s0 = await A.snap();
    const put = async (fn, camp = A.camp) => { const b = await openBody(camp); fn(b); return call('PUT', `/api/campaign/admin/${camp}`, b, admin); };
    const ok = (r, label) => { assert.equal(r.status, 200, label + ': ' + JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, label + ': ' + JSON.stringify(r.body)); };

    // 같은 값 저장 = 통과(구조 그대로)
    let r = await put(() => {});
    ok(r, '같은 값');
    assert.equal(await A.snap(), s0);

    const blocked = async (label, fn, code, field) => {
      const before = await A.snap();
      const res = await put(fn);
      assert.equal(res.status, 409, label + ': ' + JSON.stringify(res.body));
      assert.equal(res.body.code, code, label + ': ' + JSON.stringify(res.body));
      if (field) assert.ok(JSON.stringify(res.body.fields || []).includes(field), label + ': ' + JSON.stringify(res.body));
      assert.equal(await A.snap(), before, label + ' — 쓰기 0');
    };
    // ── ① 아직 막힌 구조 변경(이름·배송 한 종류끼리·리뷰타입 = 다음 순서) · 영구 금지 ──
    // 옵션 이름 바꾸기는 ③ 에서 열렸다 — bidirPhase7Rename 이 본다
    // 배송 한 종류끼리는 ⑤ 에서 열렸다 — bidirPhase7Delivery 가 본다
    // 리뷰타입 바꾸기는 ④ 에서 열렸다 — bidirPhase7ReviewType 이 본다
    await blocked('배송 혼합', b => { b.delivery_type = '혼합'; b.delivery_type_mix = [{ type: 'real', quantity: 10 }, { type: 'empty', quantity: 10 }];
      b.delivery_review_fee_mix = [{ type: 'real', reviewFee: 1000 }, { type: 'empty', reviewFee: 1000 }]; }, 'structure_new_order', '배송 방식');
    await blocked('체험단 종류', b => { b.work_kind = 'blog'; }, 'structure_new_order', '체험단 종류');
    r = await put(b => { b.work_kind = 'blog'; b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '' }); });
    assert.ok(/새 리뷰오더/.test(r.body.error), '영구 금지가 섞이면 새 오더 안내가 먼저: ' + JSON.stringify(r.body));
    await blocked('살아 있는 옵션을 마감으로(지우기로 한다)', b => { b.options[0].status = 'closed'; }, 'campaign_field_unmappable', '마감');
    await blocked('총모집을 안 맞춘 옵션 더하기', b => { b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '', recruitTotal: 4, dailyLimit: 1 }); }, 'campaign_field_unmappable', '총모집');
    await blocked('인원 0 옵션 더하기', b => { b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '', recruitTotal: 0, dailyLimit: 0 }); }, 'structure_add_zero');

    // ── ② 공고 창: 옵션 더하기 → 오더·공고 줄·작업표 빈 줄 ──
    r = await put(b => { b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '', payAmount: 13000, recruitTotal: 4, dailyLimit: 1 });
      b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '옵션 더하기');
    let p = await A.prods();
    let g = p[0].options.find(o => o.label === '그레이');
    assert.ok(g, '오더에 새 옵션: ' + JSON.stringify(p[0].options));
    assert.equal(g.count, 4); assert.equal(g.pay, 13000); assert.equal(g.option_1.value, '그레이');
    assert.equal(Number((await A.wo()).recruit_count), 24);
    assert.equal(Number((await A.wo()).pay_amount), 15900 * 5 + 21500 * 12 + 9000 * 3 + 13000 * 4, '결제합계 = 새 옵션 금액 × 인원 더함');
    let o = await A.opts();
    assert.equal(o.get('그레이').status, 'active'); assert.equal(Number(o.get('그레이').recruit_total), 4); assert.equal(o.get('그레이').product_name, '탈취제');
    assert.equal(Number((await A.cRow()).recruit_total), 24); assert.equal((await A.rows()).length, 24, '작업표 빈 줄 4줄 더함');
    assert.ok((await pool.query(`SELECT 1 FROM shared_sync_outbox WHERE work_order_id = $1 AND status = 'pending'`, [A.w.id])).rows.length, '인트라넷으로 보낼 거리');
    // 접수 때처럼 새 빈 줄 둘에 그레이 표식(배분)
    const fresh = (await A.rows()).filter(x => !x.option_text).slice(0, 2);
    for (const f of fresh) await pool.query(`UPDATE campaign_participants SET option_text = '그레이', row_json = '{"옵션":"그레이"}'::jsonb WHERE id = $1`, [f.id]);

    // ── 공고 창: 참여자 없는 옵션 지우기 → 오더·공고 줄 삭제 · 그 옵션 빈 줄은 표식을 비우고 먼저 정리 ──
    r = await put(b => { b.options = b.options.filter(x => x.optKey !== '그레이'); b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '참여 없는 옵션 지우기');
    assert.ok(!(await A.prods())[0].options.some(x => x.label === '그레이'));
    assert.ok(!(await A.opts()).has('그레이'), '공고 줄 삭제');
    assert.equal(Number((await A.cRow()).recruit_total), 20);
    const left = await A.rows();
    assert.equal(left.length, 20); assert.ok(!left.some(x => fresh.some(f => f.id === x.id)), '지운 옵션의 빈 줄을 먼저 정리했다');
    assert.ok(!left.some(x => String(x.option_text) === '그레이'), '지운 옵션 표식이 남지 않는다');

    // ── 공고 창: 참여자 있는 옵션 지우기 → 마감(인원 = 참여 수) · 총모집은 그만큼 남는다 ──
    await A.apply({ key: '블랙', count: 3 });
    r = await put(b => { b.options = b.options.filter(x => x.optKey !== '블랙'); b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '참여 있는 옵션 지우기');
    p = await A.prods();
    const bk = p[0].options.find(x => x.label === '블랙');
    assert.ok(bk && bk.closed === true, '오더에 마감으로 남는다: ' + JSON.stringify(p[0].options));
    assert.equal(bk.count, 3); assert.equal(bk.daily, 0);
    assert.equal(Number((await A.wo()).recruit_count), 18, '총모집 = 15 + 참여 3');
    o = await A.opts();
    assert.equal(o.get('블랙').status, 'closed'); assert.equal(Number(o.get('블랙').recruit_total), 3);
    assert.equal(Number((await A.cRow()).recruit_total), 18); assert.equal((await A.rows()).length, 18);
    assert.equal((await linkSharedOrder({ workOrderId: A.w.id, dryRun: true })).body.already, true);
    // 마감 줄이 있는 공고 — 공고 창은 총모집을 열린 줄만 더해 보낸다(15). 손대지 않은 저장·인원만 바꾼 저장이 "합계 다름" 으로 막히지 않는다
    const sClosed = await A.snap();
    r = await put(b => { b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '마감 줄 있는 공고 손대지 않은 저장'); assert.equal(await A.snap(), sClosed);
    r = await put(b => { const x = b.options.find(y => y.optKey === '화이트'); x.recruitTotal = Number(x.recruitTotal) + 1; b.recruit_total = sum(b, 'recruitTotal'); });
    ok(r, '마감 줄 있는 공고 인원만 바꿈');
    assert.equal(Number((await A.wo()).recruit_count), 19, '15 + 1 + 마감 3'); assert.equal(Number((await A.cRow()).recruit_total), 19);
    r = await put(b => { const x = b.options.find(y => y.optKey === '화이트'); x.recruitTotal = Number(x.recruitTotal) - 1; b.recruit_total = sum(b, 'recruitTotal'); });
    ok(r, '되돌림');
    // 마감 줄 인원은 공고 창에서도 못 고친다(오더 칸이 굳었다) — 다시 열기는 된다
    r = await put(b => { const x = b.options.find(y => y.optKey === '블랙'); x.status = 'active'; x.recruitTotal = 6; x.dailyLimit = 1;
      b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '다시 열기');
    p = await A.prods();
    assert.equal(p[0].options.find(x => x.label === '블랙').closed, undefined); assert.equal(p[0].options.find(x => x.label === '블랙').count, 6);
    assert.equal((await A.opts()).get('블랙').status, 'active'); assert.equal(Number((await A.opts()).get('블랙').recruit_total), 6);
    assert.equal(Number((await A.wo()).recruit_count), 21);

    // ── 인트라넷: 옵션 더하기 · 참여자 있는 옵션 지우기(마감으로 되돌려 보냄) ──
    let cur = await A.wo();
    let out = await A.intranet(edited(cur, x => x[0].options.push({ option_1: { name: '옵션', value: '네이비' }, label: '네이비', url: '', pay: 15000, count: 2, daily: 1, review_type_mix: [] })));
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.push_back, false, '보낸 그대로 저장 = 되돌려 보낼 것 없음');
    assert.equal((await A.opts()).get('네이비').status, 'active'); assert.equal(Number((await A.cRow()).recruit_total), 23);
    out = await A.intranet(edited(await A.wo(), x => x[0].options.splice(x[0].options.findIndex(y => y.label === '블랙'), 1)));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.closed_options, [{ pName: '탈취제', oLabel: '블랙', used: 3 }]);
    assert.equal(out.body.push_back, true, '마감으로 되살렸으니 인트라넷 사본을 다시 맞춘다');
    assert.equal((await A.prods())[0].options.find(x => x.label === '블랙').closed, true);
    assert.equal(Number((await A.wo()).recruit_count), 20, '23 − 6 + 참여 3');
    assert.equal((await A.opts()).get('블랙').status, 'closed');
    // 구조를 모르는 옛 인트라넷 창 = 막힘(쓰기 0)
    const sOld = await A.snap();
    out = await A.intranet(edited(await A.wo(), x => x[0].options.push({ option_1: { name: '옵션', value: '베이지' }, label: '베이지', url: '', pay: 1, count: 1, daily: 0, review_type_mix: [] })), { structure: false });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'field_not_editable', JSON.stringify(out.body)); assert.equal(await A.snap(), sOld);
    // 다른 상품에 같은 옵션 이름 → 공고 줄 이름이 바뀌어야 해서 거부
    out = await A.intranet(edited(await A.wo(), x => x.push({ name: '세번째', url: 'https://smartstore.naver.com/x/products/3', option_schema_version: 2, product_mode: 'opt',
      base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [{ option_1: { name: '옵션', value: '화이트' }, label: '화이트', url: '', pay: 1, count: 1, daily: 0, review_type_mix: [] }] })));
    assert.equal(out.status, 409); assert.equal(out.body.code, 'campaign_rejected', JSON.stringify(out.body)); assert.equal(out.body.reason, 'option_key_shift'); assert.equal(await A.snap(), sOld);
    // 상품째 지우기(두번째 · 참여 0) → 공고 줄 삭제
    out = await A.intranet(edited(await A.wo(), x => x.splice(1, 1)));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok(!(await A.opts()).has('두번째')); assert.equal(Number((await A.wo()).recruit_count), 17);

    // ══ 검토 2026-10-21 반영 ══
    // ① 낡은 공고 창 — 창을 연 뒤 인트라넷이 더하거나 지운 줄을 되돌리지 않는다 · 창을 연 뒤 마감된 줄을 다시 열지 않는다
    let bS = await openBody(A.camp);
    out = await A.intranet(edited(await A.wo(), x => { x[0].options = x[0].options.filter(y => y.label !== '네이비');
      x[0].options.push({ option_1: { name: '옵션', value: '라임' }, label: '라임', url: '', pay: 1000, count: 1, daily: 0, review_type_mix: [] }); }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    bS.title = '낡은 창 제목';
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, bS, admin);
    ok(r, '낡은 창 제목만');
    o = await A.opts();
    assert.equal(o.get('라임') && o.get('라임').status, 'active', '창을 연 뒤 더한 줄을 지우지 않는다'); assert.ok(!o.has('네이비'), '창을 연 뒤 지운 줄을 되살리지 않는다');
    assert.ok((await A.prods())[0].options.some(y => y.label === '라임'));
    bS = await openBody(A.camp);
    await A.apply({ key: '라임', count: 1 });
    out = await A.intranet(edited(await A.wo(), x => { x[0].options = x[0].options.filter(y => y.label !== '라임'); }));
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal((await A.opts()).get('라임').status, 'closed');
    bS.title = '낡은 창 제목 2';
    ok(await call('PUT', `/api/campaign/admin/${A.camp}`, bS, admin), '낡은 창(라임 살아 있음)');
    assert.equal((await A.opts()).get('라임').status, 'closed', '낡은 창이 마감 줄을 다시 열지 않는다');
    assert.equal(Number((await A.opts()).get('라임').recruit_total), 1);
    // ② 스위치 꺼짐 + 마감 줄 있는 공고 — 손대지 않은 저장이 총모집을 버전 없이 줄이지 않는다
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    const wv = await A.wo();
    r = await put(b => { b.title = '스위치 꺼짐 제목'; });
    ok(r, '스위치 꺼짐 제목만');
    assert.equal(Number((await A.wo()).recruit_count), Number(wv.recruit_count)); assert.equal(String((await A.wo()).sync_version), String(wv.sync_version));
    assert.equal(Number((await A.cRow()).recruit_total), Number(wv.recruit_count), '공고 총모집도 그대로(마감 줄 인원 포함)');
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    // ③ 인트라넷 같은 이름으로 다시 더하기 = 다시 열기(합계·결제금액 맞음)
    out = await A.intranet(edited(await A.wo(), x => { const y = x[0].options.find(z => z.label === '블랙'); delete y.closed; y.count = 5; y.daily = 1; }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await A.opts()).get('블랙').status, 'active'); assert.equal(Number((await A.opts()).get('블랙').recruit_total), 5);
    // ④ 창을 연 뒤 다른 쪽에서 마감된 줄의 인원을 바꾼 저장 = 409(마감 = 참여 수 지킴)
    const old = await A.wo();
    r = await put(b => { b.options = b.options.filter(y => y.optKey !== '블랙'); b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '공고 창 블랙 지움(참여 3 → 마감)');
    assert.equal((await A.opts()).get('블랙').status, 'closed');
    const sMw = await A.snap();
    const mw = JSON.parse(old.product_options_json); mw[0].options.find(y => y.label === '블랙').count = 7;
    out = await applySharedPatch({ workOrderId: A.w.id, mine: { ...readSharedState(old), product_options_json: JSON.stringify(mw), recruit_count: Number(old.recruit_count) + 2 },
      baseVersion: Number(old.sync_version), origin: 'intranet', actor: '인트라넷', conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: true });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'closed_meanwhile'); assert.equal(await A.snap(), sMw);
    // ⑤ 구조를 모르는 옛 인트라넷 창 — 마감 표시를 모르는 사본(closed 없음)으로 저장해도 막히지 않고 마감은 그대로
    const cur5 = await A.wo();
    const oldCopy = JSON.parse(cur5.product_options_json); oldCopy[0].options.forEach(y => { delete y.closed; });
    out = await applySharedPatch({ workOrderId: A.w.id, mine: { ...readSharedState(cur5), product_options_json: JSON.stringify(oldCopy), special_notes: '옛 창 특이사항' },
      baseVersion: Number(cur5.sync_version), origin: 'intranet', actor: '옛 인트라넷', conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: false });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal((await A.wo()).special_notes, '옛 창 특이사항');
    assert.equal((await A.prods())[0].options.find(y => y.label === '블랙').closed, true, '마감은 그대로'); assert.equal(out.body.push_back, true, '옛 창 사본을 다시 맞춘다');
    // ⑥ 같은 상품에서 같은 옵션 값을 지우고 더함(표기만 다름) = 이름 바꾸기로 보고 거부
    const sRn = await A.snap();
    out = await A.intranet(edited(await A.wo(), x => { const i = x[0].options.findIndex(y => y.label === '화이트'); const w0 = x[0].options[i];
      x[0].options.splice(i, 1, { ...w0, option_1: { name: '색상', value: '화이트' }, label: '색상 화이트' }); }));
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'structure_rename_pending'); assert.equal(await A.snap(), sRn);
    // ⑦ 가이드유입 작업에 가이드 없는 옵션 더하기 = 거부
    const wd0 = (await A.cRow()).work_detail;
    await pool.query(`UPDATE recruit_campaigns SET work_detail = work_detail || '{"inflowType":"guide"}'::jsonb WHERE id = $1`, [A.camp]);
    out = await A.intranet(edited(await A.wo(), x => x[0].options.push({ option_1: { name: '옵션', value: '민트' }, label: '민트', url: '', pay: 1, count: 1, daily: 0, review_type_mix: [] })));
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'guide_missing', JSON.stringify(out.body));
    await pool.query(`UPDATE recruit_campaigns SET work_detail = $2::jsonb WHERE id = $1`, [A.camp, JSON.stringify(wd0)]);
    // ⑧ 영구 금지 작업은 더하기·지우기 버튼을 열지 않는다
    const cur8 = await A.wo();
    assert.equal(await SP.structureOpenFor(pool, cur8), true);
    assert.equal(await SP.structureOpenFor(pool, { ...cur8, work_kind: 'blog' }), false);
    assert.equal(await SP.structureOpenFor(pool, { ...cur8, delivery_type: '혼합', delivery_type_mix: [{ type: 'real', quantity: 1 }, { type: 'empty', quantity: 1 }] }), false);

    // ══ 재검토 2026-10-21 반영 ══
    // Ⓑ 옛 인트라넷 창이 마감 줄 인원을 고쳐도 마감 줄은 그대로(인원 = 참여 수)
    const curB = await A.wo();
    const oldB = JSON.parse(curB.product_options_json); oldB[0].options.forEach(y => { if (y.label === '블랙') { delete y.closed; y.count = 8; } });
    out = await applySharedPatch({ workOrderId: A.w.id, mine: { ...readSharedState(curB), product_options_json: JSON.stringify(oldB), recruit_count: Number(curB.recruit_count) + 5 },
      baseVersion: Number(curB.sync_version), origin: 'intranet', actor: '옛 인트라넷', conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: false });
    const bkB = (await A.prods())[0].options.find(y => y.label === '블랙');
    assert.ok(bkB.closed === true && bkB.count === 3, '옛 창의 마감 줄 인원은 받지 않는다: ' + JSON.stringify(out.body).slice(0, 300));
    assert.equal(Number((await A.opts()).get('블랙').recruit_total), 3);
    // Ⓔ 배송 혼합 작업 — 공고 창 더하기·지우기도 새 리뷰오더 안내
    await pool.query(`UPDATE work_orders SET delivery_type = '혼합', delivery_type_mix = '[{"type":"real","quantity":1},{"type":"empty","quantity":1}]'::jsonb WHERE id = $1`, [A.w.id]);
    r = await put(b => { b.options = b.options.filter(y => y.optKey !== '화이트'); b.recruit_total = sum(b, 'recruitTotal'); });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'structure_new_order', JSON.stringify(r.body));
    await pool.query(`UPDATE work_orders SET delivery_type = '실배송', delivery_type_mix = '[]'::jsonb WHERE id = $1`, [A.w.id]);
    // Ⓐ 남은 자리 < 지우는 옵션 참여 수 — 공고 창에서 지우기가 앞 단 검사에 막히지 않는다(공유 저장이 마감 반영 뒤 같은 트랜잭션에서 하한을 본다)
    const F = await setup('f');
    await F.apply({ key: '블랙', count: 3 }); await F.apply({ key: '화이트', count: 12 }); await F.apply({ key: '두번째', count: 3 });
    r = await put(b => { b.options = b.options.filter(y => y.optKey !== '블랙'); b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); }, F.camp);
    ok(r, '거의 찬 공고에서 참여 있는 옵션 지우기');
    assert.equal((await F.opts()).get('블랙').status, 'closed'); assert.equal(Number((await F.cRow()).recruit_total), 18, '15 + 마감 3');
    assert.equal(Number((await F.wo()).recruit_count), 18);

    // ── 리뷰타입 섞어 쓰기 작업 — 참여자 있는 옵션 지우기는 거부(참여한 사람의 리뷰타입을 나눌 수 없다) ──
    await pool.query(`UPDATE work_orders SET review_type = '혼합' WHERE id = $1`, [A.w.id]);
    await A.apply({ key: '화이트', count: 1 });
    const sMix = await A.snap();
    out = await A.intranet(edited(await A.wo(), x => x[0].options.splice(x[0].options.findIndex(y => y.label === '화이트'), 1)));
    assert.equal(out.status, 409); assert.equal(out.body.code, 'structure_close_mixed', JSON.stringify(out.body)); assert.equal(await A.snap(), sMix);
    await pool.query(`UPDATE work_orders SET review_type = '포토' WHERE id = $1`, [A.w.id]);

    // ── 스위치 꺼짐 · 옛 공고 창(기준 없음) ──
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    await blocked('스위치 꺼짐 + 옵션 더하기', b => b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '', status: 'active' }), 'counts_link_paused');
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    await blocked('옛 공고 창 + 옵션 더하기', b => { b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '', status: 'active' }); delete b.bidir_base_sync_version; }, 'stale_editor');
    // 리뷰어앱 공고 수정 — 배송 방식(같은 값은 통과)
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { delivery_type: '빈박스' }, scoped);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'shared_field_scoped'); assert.deepEqual(r.body.fields, ['배송 방식']);
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { delivery_type: '실배송', title: '같은 배송 + 제목' }, scoped);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // 옵션 합치기
    r = await call('POST', `/api/campaign/admin/${A.camp}/options/merge`, { pairs: [{ from: '블랙', to: '화이트' }], confirm: true }, admin);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'structure_linked_pending');
    assert.ok((await A.opts()).has('블랙'), '합치기 쓰기 0');

    // 연결 안 된 공고 = 종전대로(옵션 더하기 저장됨)
    const N = await setup('n', { link: false });
    const nb = await openBody(N.camp);
    nb.options.push({ ...nb.options[0], optKey: '그레이', prevOptKey: '' });
    r = await call('PUT', `/api/campaign/admin/${N.camp}`, nb, admin);
    ok(r, '연결 안 된 공고');
    assert.ok((await N.opts()).has('그레이'));
    console.log('bidirPhase7Structure: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    sw._resetBidirSwitchCacheForTest();
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_participants WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM campaign_fee_schedules WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_plan_events WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
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
  console.log('bidirPhase7Structure: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
