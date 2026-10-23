/**
 * 양방향 7단계-③ 주말 포함 여부(결정 274 · 사용자 확정 2026-10-21 「권장안으로 진행」 = 가).
 *   ① 판정 — 참·거짓만 쓸 수 있다(빈 값 = "아직 안 정함" 은 막힘) · 옛 공고 창(기준 없음)은 주말 차이를 받지 않는다
 *   ② (PGTEST_URL) 진짜 PG + 실제 라우트:
 *      인트라넷이 주말 제외로 → 공고 주말 설정 · 날짜별로 직접 정해 둔 인원은 그대로 · 참여자가 채운 줄 그대로
 *      주말을 모르는 옛 인트라넷 창(weekends 표시 없음) → 버림 · 빈 값 → 409
 *      공고 창 주말 포함으로 → 오더 · 인트라넷으로 보낼 값에 주말 포함 · 스위치 꺼짐 → 409
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');
const SP = require('../src/services/sharedPatch.service');
const { ABSENT } = require('../src/utils/sharedPatchPlan');

const OPT_PRODUCTS = [
  { name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] },
  { name: '두번째', url: 'https://smartstore.naver.com/x/products/9', option_schema_version: 2, product_mode: 'none',
    base: { pay: 9000, count: 3, daily: 1, review_type_mix: [] }, options: [] },
];

{
  const f = (base, mine) => SP.writablePath({ meta: { kind: 'field', key: 'skip_weekends' }, base, mine }, 'intranet');
  assert.equal(f('false', 'true'), true); assert.equal(f(true, false), true);
  assert.equal(f('true', ''), false, '빈 값 = 아직 안 정함 → 막힘'); assert.equal(f('true', ABSENT), false); assert.equal(f('true', null), false);
  assert.ok(SP.PUSH_VIEW_KEYS.includes('skip_weekends'), '인트라넷으로 보내는 칸');
  const E = require('../src/utils/campaignSharedEdit');
  assert.deepEqual(E.moneyDriftFromCampaign({ skip_weekends: false }, { skip_weekends: true }), ['주말 제외'], '옛 공고 창 = 주말 차이 거부');
  assert.deepEqual(E.moneyDriftFromCampaign({ skip_weekends: true }, { skip_weekends: true }), []);
}
console.log('bidirPhase7Weekend: static passed');

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
  const SHEET = 'sheet_p7w';
  /** 인트라넷 오더 + 발행 그대로인 공고(무시트 작업표 줄 = 총모집) + 연결. */
  const setup = async (tag, products, extra = {}) => {
    const sid = `ro_p7w_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7w_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7w_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(products);
    const payload = {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 주말 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
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
    const intranet = async (patch, { counts = true, weekends = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: counts, weekendsCapable: weekends });
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
    const A = await setup('wk', OPT_PRODUCTS);
    assert.equal((await A.cRow()).skip_weekends, false);
    // 리뷰웹에서 사람이 날짜별로 정해 둔 인원(다음 토요일 3명) — 주말 설정을 바꿔도 그대로여야 한다(사용자 확정 가)
    const sat = (await pool.query(`SELECT to_char(d, 'YYYY-MM-DD') d FROM generate_series(CURRENT_DATE + 1, CURRENT_DATE + 8, '1 day') d WHERE extract(dow from d) = 6 LIMIT 1`)).rows[0].d;
    await pool.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by, updated_at) VALUES ($1, $2::date, 3, '시험관리자', NOW())`, [A.camp, sat]);
    const plans = async () => (await pool.query(`SELECT to_char(plan_date,'YYYY-MM-DD') d, planned_count n FROM campaign_daily_plans WHERE campaign_id = $1 ORDER BY plan_date`, [A.camp])).rows;
    const filled = async () => (await A.rows()).filter(x => x.reviewer_name).map(x => x.seq).join(',');
    const filled0 = await filled();

    // 빈 줄 날짜 다시 배치(기존 장치 relayCampaignWorktable)를 부르는지 — 가짜 작업표는 날짜 칸 설정이 없어 실제 배치는 건너뛴다
    const plan = require('../src/services/campaignPlan.service');
    const relayCalls = []; const realRelay = plan.relayCampaignWorktable;
    plan.relayCampaignWorktable = async (id, o) => { relayCalls.push([id, o && o.by]); return realRelay(id, o); };
    // ① 인트라넷 → 주말 제외
    let r = await A.intranet({ skip_weekends: true });
    assert.ok(relayCalls.some(([id]) => id === A.camp), '커밋 뒤 빈 줄 날짜 다시 배치를 부른다: ' + JSON.stringify(relayCalls));
    relayCalls.length = 0;
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok((r.body.campaign_applied || []).includes('weekends'), JSON.stringify(r.body));
    assert.equal((await A.cRow()).skip_weekends, true); assert.equal((await A.wo()).skip_weekends, true);
    assert.deepEqual(await plans(), [{ d: sat, n: 3 }], '날짜별로 직접 정해 둔 인원은 그대로');
    assert.equal(await filled(), filled0, '참여자가 채운 줄 그대로'); assert.equal((await A.rows()).length, 20, '줄 수 그대로');

    plan.relayCampaignWorktable = realRelay;
    // ② 주말을 모르는 옛 인트라넷 창 → 버림
    r = await A.intranet({ skip_weekends: false, special_notes: '옛 창' }, { weekends: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await A.wo()).skip_weekends, true, '옛 창의 주말 값은 받지 않는다'); assert.equal((await A.wo()).special_notes, '옛 창');
    // ③ 빈 값(아직 안 정함) → 409 쓰기 0
    const v0 = Number((await A.wo()).sync_version);
    r = await A.intranet({ skip_weekends: null });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'field_not_editable');
    assert.equal(Number((await A.wo()).sync_version), v0);

    // ④ 공고 창 → 주말 포함
    const openBody = async (camp) => {
      const dd = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
      const c0 = dd.body.data;
      return { title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
        work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
        channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
        recruit_total: c0.recruit_total, daily_limit: c0.daily_limit, skip_weekends: c0.skip_weekends === true,
        options: (dd.body.options || []).map(x => ({ optKey: x.optKey, productName: x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
          recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
        fee_schedules: (dd.body.feeSchedules || []).map(x => ({ effectiveFrom: x.effectiveFrom, reviewFee: x.reviewFee, memo: x.memo })),
        bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined };
    };
    let eb = await openBody(A.camp);
    assert.equal(eb.skip_weekends, true);
    eb.skip_weekends = false;
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.ok(r.body.shared && r.body.shared.changed.includes('주말 제외'), JSON.stringify(r.body.shared));
    assert.equal((await A.wo()).skip_weekends, false, '오더도 주말 포함'); assert.equal((await A.cRow()).skip_weekends, false);
    assert.deepEqual(await plans(), [{ d: sat, n: 3 }]);
    const ob = (await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1`, [A.w.id])).rows[0].n;
    assert.ok(ob >= 1, '인트라넷으로 보낼 거리');
    // 같은 값 다시 저장 = 공유 저장 없음
    eb = await openBody(A.camp);
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.shared, undefined, '주말 그대로 = 공유 저장 없음');

    // ⑥ 오더·공고가 이미 갈라진 공고(검토 2026-10-21) — 오더 false · 공고 true 로 만든다
    await pool.query('UPDATE recruit_campaigns SET skip_weekends = TRUE WHERE id = $1', [A.camp]);
    const vD = Number((await A.wo()).sync_version);
    eb = await openBody(A.camp); assert.equal(eb.skip_weekends, true, '창은 공고 값으로 열린다');
    eb.title = '제목만 고침';
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await A.wo()).skip_weekends, false, '손대지 않은 저장이 오더를 공고 값으로 뒤집지 않는다'); assert.equal(Number((await A.wo()).sync_version), vD);
    assert.equal((await A.cRow()).skip_weekends, true, '공고도 그대로(정리는 직원이 고른다)');
    eb = await openBody(A.camp); eb.skip_weekends = false;   // 사람이 공고를 오더 값으로 되돌림
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await A.cRow()).skip_weekends, false, '공고가 오더 값으로 맞춰진다(종전: 확인창까지 띄우고 아무것도 저장 안 됨)');
    assert.equal((await A.wo()).skip_weekends, false); assert.equal(Number((await A.wo()).sync_version), vD, '오더는 그대로');

    // ⑤ 스위치 꺼짐 → 공고 창 주말 변경 409(오더가 버전 없이 갈라지지 않게)
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    eb = await openBody(A.camp); eb.skip_weekends = true;
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'counts_link_paused');
    assert.equal((await A.cRow()).skip_weekends, false, '쓰기 0');
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    console.log('bidirPhase7Weekend: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_participants WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM campaign_daily_plans WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
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
  console.log('bidirPhase7Weekend: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
