/**
 * 양방향 7단계-④ ④ 리뷰타입 바꾸기(결정 263 · 사용자 확정 2026-10-21 「1.가 2.가 3.가」).
 *   한 종류 ↔ 섞어 쓰기 · 섞는 종류 → 오더·공고(리뷰타입·혼합 수량·배지·작업 탭) · 작업표 **빈 줄** 리뷰옵션을 새 비율로(가중 차례로 고르게).
 *   1.가 손으로 고친 줄 그대로 · 2.가 이미 정해진 줄(채운 줄 + 손으로 고친 줄) 수보다 적게 줄이거나 빼면 거부 · 3.가 인원만 바뀌어도 빈 줄을 맞춘다.
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
  const { interleave } = require('../src/services/reviewOptionRedistribute.service');
  const seq = interleave(new Map([['photo', 2], ['text', 4]]), 6);
  assert.deepEqual(seq.filter(t => t === 'photo').length, 2); assert.deepEqual(seq.filter(t => t === 'text').length, 4);
  assert.ok(!(seq[0] === 'photo' && seq[1] === 'photo'), '한 유형이 앞에 몰리지 않는다: ' + seq.join(','));
  assert.deepEqual(interleave(new Map([['photo', 1]]), 3), ['photo', '', ''], '칸이 많으면 남는 칸은 빈 칸');
  const SP = require('../src/services/sharedPatch.service');
  assert.ok(SP.PHASE7R_SHARED_FIELDS.includes('review_type') && SP.PUSH_VIEW_KEYS.includes('review_type'));
}
console.log('bidirPhase7ReviewType: static passed');

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
  const SHEET = 'sheet_p7t';
  /** 인트라넷 오더 + 발행 그대로인 공고(옵션 줄) + 무시트 작업표(총모집만큼 빈 줄, 옵션 배정 표식) + 연결(link=false 면 연결 안 함). */
  const setup = async (tag, { link = true, extra = {} } = {}) => {
    const sid = `ro_p7t_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7t_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7t_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(OPT_PRODUCTS);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 리뷰타입 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
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
    const intranet = async (patch, { structure = true, rename = true, reviewtype = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: structure, renameCapable: rename, reviewTypeCapable: reviewtype });
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
    const ok = (r, label) => { assert.equal(r.status, 200, label + ': ' + JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, label + ': ' + JSON.stringify(r.body)); };
    const put = async (fn, camp = A.camp) => { const b = await openBody(camp); fn(b); return call('PUT', `/api/campaign/admin/${camp}`, b, admin); };
    const ro = async () => (await A.rows()).map(x => ({ id: x.id, v: String((x.row_json || {})['리뷰옵션'] ?? ''), filled: !!x.reviewer_name }));
    const tally = list => list.reduce((m, x) => (m[x.v] = (m[x.v] || 0) + 1, m), {});
    const mixOf = (photo, text, extra = []) => [{ type: 'photo', quantity: photo }, { type: 'text', quantity: text }, ...extra];
    // 채운 줄 2(포토리뷰) — 산 사람의 줄
    const r0 = await A.rows();
    for (const x of r0.slice(0, 2)) await pool.query(`UPDATE campaign_participants SET reviewer_name = '가짜구매', row_json = row_json || '{"리뷰옵션":"포토리뷰"}'::jsonb WHERE id = $1`, [x.id]);
    const filledIds = r0.slice(0, 2).map(x => x.id);

    // T1 포토 → 혼합(포토 10 · 텍스트 10)
    let out = await A.intranet({ review_type: '혼합', review_type_mix: mixOf(10, 10) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    let t = tally(await ro());
    assert.equal(t['포토리뷰'], 10, JSON.stringify(t)); assert.equal(t['텍스트'], 10, JSON.stringify(t));
    assert.ok((await ro()).filter(x => filledIds.includes(x.id)).every(x => x.v === '포토리뷰'), '채운 줄 그대로');
    let c = await A.cRow();
    assert.equal(c.review_type, 'mixed'); assert.equal(JSON.stringify(c.review_type_mix.map(e => `${e.type}:${e.quantity}`).sort()), JSON.stringify(['photo:10', 'text:10']));
    assert.equal((await pool.query(`SELECT review_type FROM tab_configs WHERE sheet_id = 'sheet_p7t' AND tab_name = $1`, [A.tab])).rows[0].review_type, '혼합');
    assert.equal((await A.wo()).review_type, '혼합');

    // T2 손으로 고친 빈 줄(구매확정) — 그대로 두고, 새 비율에 구매확정이 없으면 거부 · 있으면 그 줄을 셈에 넣는다
    const manualRow = (await ro()).find(x => !x.filled);
    await pool.query(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by) VALUES ('sheet_p7t', $1, 'manual', $2, 'col:리뷰옵션', 'text', '구매확정', '담당자')`, [A.tab, String(manualRow.id)]);
    const s2 = await A.snap();
    out = await A.intranet({ review_type_mix: mixOf(12, 8) });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'review_type_below_used', JSON.stringify(out.body)); assert.equal(await A.snap(), s2);
    out = await A.intranet({ review_type_mix: mixOf(11, 8, [{ type: 'confirm', quantity: 1 }]) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const notManual = list => list.filter(x => x.id !== manualRow.id);   // 손으로 고친 줄은 화면에 손 글씨(구매확정)가 보인다 — 저장 값은 건드리지 않는다
    const vManual0 = manualRow.v;
    t = tally(notManual(await ro()));
    assert.equal(t['포토리뷰'], 11, JSON.stringify(t)); assert.equal(t['텍스트'], 8, JSON.stringify(t));
    assert.equal((await ro()).find(x => x.id === manualRow.id).v, vManual0, '손으로 고친 줄은 다시 나누지 않는다');
    assert.ok((await A.cRow()).badges.includes('구매확정'), '구매확정이 섞이면 배지');

    // T3 이미 산 포토 2줄보다 적게 = 거부
    out = await A.intranet({ review_type_mix: mixOf(1, 18, [{ type: 'confirm', quantity: 1 }]) });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'review_type_below_used');

    // T5 인원만 늘림(화이트 +2 · 혼합 텍스트 +2) — 새 빈 줄도 리뷰옵션이 채워진다(3.가)
    out = await A.intranet({ ...edited(await A.wo(), x => { x[0].options[1].count += 2; }), review_type_mix: mixOf(11, 10, [{ type: 'confirm', quantity: 1 }]) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const r5 = await ro();
    assert.equal(r5.length, 22); assert.equal(r5.filter(x => !x.v && !x.filled && x.id !== manualRow.id).length, 0, '빈 칸 빈 줄 없음: ' + JSON.stringify(tally(r5)));
    assert.equal(tally(notManual(r5))['텍스트'], 10); assert.equal(tally(notManual(r5))['포토리뷰'], 11);

    // T6 리뷰타입을 모르는 옛 창 — 섞는 종류 바꾸기는 "안 보낸 칸" 으로 버린다(그 창은 리뷰타입이 잠겨 있다 · 옛 사본 값 재전송에 막히지 않게 · 검토 2026-10-21)
    const s6 = await A.snap(); const rt6 = (await A.wo()).review_type; const mix6 = JSON.stringify((await A.wo()).review_type_mix);
    out = await A.intranet({ review_type_mix: mixOf(11, 9, [{ type: 'confirm', quantity: 1 }, { type: 'star', quantity: 1 }]) }, { reviewtype: false });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(JSON.stringify((await A.wo()).review_type_mix), mix6); assert.equal(await A.snap(), s6);
    out = await A.intranet({ review_type: '텍스트', review_type_mix: [] }, { reviewtype: false });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal((await A.wo()).review_type, rt6); assert.equal((await A.cRow()).review_type, 'mixed'); assert.equal(await A.snap(), s6);

    // T4 한 종류로 바꾸기도 이미 정해진 줄이 쓰는 유형이 사라지면 거부(사용자 확정 2026-10-21 「가」) — 아무것도 안 바뀐다
    const s4 = await A.snap();
    out = await A.intranet({ review_type: '텍스트', review_type_mix: [] });   // 산 포토 2줄
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'review_type_below_used', JSON.stringify(out.body)); assert.equal(await A.snap(), s4);
    assert.ok(/포토/.test(out.body.error) && /새 리뷰오더/.test(out.body.error), out.body.error);
    out = await A.intranet({ review_type: '포토', review_type_mix: [] });     // 손으로 고친 구매확정 1줄
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'review_type_below_used', JSON.stringify(out.body)); assert.equal(await A.snap(), s4);
    // 손 글씨를 되돌리면 혼합 → 포토 가능 — 혼합 수량 비움 · 빈 줄 비움(옛 판 = 한 종류면 빈 칸) · 채운 줄 그대로
    await pool.query(`UPDATE participant_edits SET reverted_at = NOW() WHERE sheet_id = 'sheet_p7t' AND tab_name = $1 AND anchor_value = $2`, [A.tab, String(manualRow.id)]);
    out = await A.intranet({ review_type: '포토', review_type_mix: [] });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    c = await A.cRow();
    assert.equal(c.review_type, 'photo'); assert.deepEqual(c.review_type_mix, []); assert.ok(!c.badges.includes('구매확정'));
    const r4 = await ro();
    assert.ok(r4.filter(x => !x.filled).every(x => x.v === ''), '빈 줄은 빈 칸(옛 판 한 종류)');
    assert.ok(r4.filter(x => filledIds.includes(x.id)).every(x => x.v === '포토리뷰'), '채운 줄 그대로');
    assert.deepEqual((await A.wo()).review_type_mix, []);

    // T7 공고 창에서도 같은 규칙 — 산 포토 줄이 있는데 텍스트 하나로 = 저장 안 됨(오더·공고 그대로)
    const s7 = await A.snap();
    let r = await put(b => { b.review_type = 'text'; });
    assert.ok(r.status !== 200 || r.body.ok === false, '공고 창 텍스트 거부: ' + JSON.stringify(r.body));
    assert.equal((await A.wo()).review_type, '포토'); assert.equal((await A.cRow()).review_type, 'photo'); assert.equal(await A.snap(), s7);
    // T8 마감 줄이 있는 작업은 섞어 쓰기로 못 바꾼다
    const B = await setup('b');
    await B.apply({ key: '블랙', count: 1 });
    out = await B.intranet(edited(await B.wo(), x => { x[0].options = x[0].options.filter(y => y.label !== '블랙'); }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const sb = await B.snap();
    out = await B.intranet({ review_type: '혼합', review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: Number((await B.wo()).recruit_count) - 10 }] });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'review_type_closed_mixed'); assert.equal(await B.snap(), sb);
    // T9 실제 수신 경로처럼 혼합 수량이 글자(JSON)로 와도 공고 칸에 배열로 들어간다(2026-10-21 인트라넷 화면 시험에서 공고 칸 검사에 걸려 저장이 통째로 실패했다)
    const C9 = await setup('c');
    const n9 = Number((await C9.wo()).recruit_count);
    out = await C9.intranet({ review_type: '혼합', review_type_mix: JSON.stringify([{ type: 'photo', quantity: 10 }, { type: 'text', quantity: n9 - 10 }]) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    let c9 = await C9.cRow();
    assert.equal(c9.review_type, 'mixed'); assert.ok(Array.isArray(c9.review_type_mix), JSON.stringify(c9.review_type_mix));
    assert.equal(JSON.stringify(c9.review_type_mix.map(e => `${e.type}:${e.quantity}`).sort()), JSON.stringify(['photo:10', `text:${n9 - 10}`]));
    // 수량만 바꾸는 경로(인원 반영)도 같은 글자 모양으로
    out = await C9.intranet({ review_type_mix: JSON.stringify([{ type: 'photo', quantity: 12 }, { type: 'text', quantity: n9 - 12 }]) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    c9 = await C9.cRow();
    assert.ok(Array.isArray(c9.review_type_mix)); assert.equal(c9.review_type_mix.find(e => e.type === 'photo').quantity, 12);
    // T10 옛 판 한 종류(포토)에서 산 줄의 리뷰옵션이 빈 칸이어도 그 유형(포토)으로 센다(검토 2026-10-21 🔴 — 안 세면 비율이 틀어지고 줄이기 거부가 빠진다)
    const D = await setup('d');
    const d0 = await D.rows();
    for (const x of d0.slice(0, 2)) await pool.query(`UPDATE campaign_participants SET reviewer_name = '가짜구매' WHERE id = $1`, [x.id]);
    const nD = Number((await D.wo()).recruit_count);
    const sD = await D.snap();
    out = await D.intranet({ review_type: '혼합', review_type_mix: [{ type: 'photo', quantity: 1 }, { type: 'text', quantity: nD - 1 }] });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'review_type_below_used', JSON.stringify(out.body)); assert.equal(await D.snap(), sD);
    out = await D.intranet({ review_type: '혼합', review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: nD - 10 }] });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const dRows = (await D.rows()).map(x => ({ v: String((x.row_json || {})['리뷰옵션'] ?? ''), filled: !!x.reviewer_name }));
    const dt = dRows.filter(x => !x.filled).reduce((m, x) => (m[x.v] = (m[x.v] || 0) + 1, m), {});
    assert.equal(dt['포토리뷰'], 8, JSON.stringify(dt)); assert.equal(dt['텍스트'], nD - 10, JSON.stringify(dt));
    assert.ok(dRows.filter(x => x.filled).every(x => x.v === ''), '산 줄은 그대로(빈 칸)');

    // T11 접수 뒤 영구 금지 작업(회수)은 서버가 리뷰타입 바꾸기를 막는다(창 목록만 숨기던 틈 · 검토 2026-10-21)
    const E = await setup('e');
    await pool.query(`UPDATE work_orders SET delivery_type = '회수' WHERE id = $1`, [E.w.id]);
    const sE = await E.snap();
    out = await E.intranet({ review_type: '텍스트', review_type_mix: [] });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'review_type_locked'); assert.equal(await E.snap(), sE);

    // T12 오더·공고가 이미 갈라진 공고(이 기능 전에 공고 창이 직접 씀)에서 공고 값을 오더 값으로 되돌리면 공고만 오더 값으로 맞춘다(검토 2026-10-21)
    const F = await setup('f');
    await pool.query(`UPDATE recruit_campaigns SET review_type = 'text' WHERE id = $1`, [F.camp]);
    const vF = Number((await F.wo()).sync_version);
    r = await put(b => { b.review_type = 'photo'; }, F.camp);
    ok(r, '공고 창 오더 값으로 되돌리기');
    assert.equal((await F.cRow()).review_type, 'photo'); assert.equal((await F.wo()).review_type, '포토'); assert.equal(Number((await F.wo()).sync_version), vF, '오더는 그대로');
    // 오더와 다른 값은 맞추기로 쓰지 않는다 — 공유 저장(오더 → 공고)으로만
    r = await put(b => { b.review_type = 'text'; }, F.camp);
    ok(r, '공고 창 텍스트');
    assert.equal((await F.wo()).review_type, '텍스트'); assert.equal((await F.cRow()).review_type, 'text');
    // T13 옛 판 한 종류(포토) · 리뷰옵션 칸 자체가 없는 작업표 · 산 줄 2 → 텍스트 하나로 = 거부(빈 칸 산 줄 = 저장 전 유형) / 인원만 바꾸기는 그대로 된다
    const G = await setup('g');
    for (const x of (await G.rows()).slice(0, 2)) await pool.query(`UPDATE campaign_participants SET reviewer_name = '가짜구매' WHERE id = $1`, [x.id]);
    const sG = await G.snap();
    out = await G.intranet({ review_type: '텍스트', review_type_mix: [] });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'review_type_below_used', JSON.stringify(out.body)); assert.equal(await G.snap(), sG);
    out = await G.intranet(edited(await G.wo(), x => { x[0].options[1].count += 1; }));
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal((await G.wo()).review_type, '포토');
    console.log('bidirPhase7ReviewType: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    sw._resetBidirSwitchCacheForTest();
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM participant_edits WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
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
  console.log('bidirPhase7ReviewType: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
