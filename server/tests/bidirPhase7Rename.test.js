/**
 * 양방향 7단계-④ ③ 상품·옵션 이름 바꾸기(결정 263 · 결정 197 · 사용자 확정 2026-10-21 「2.가」).
 *   신청 기록·아직 아무도 채우지 않은 작업표 빈 줄 = 새 이름 / 산 주문·채운 줄 = 산 당시 이름(완화 금지).
 *   ① 판정: 원래 이름(prev_label/prev_name)을 실은 줄만 이름 바꾸기 · 기준에 없는 원래 이름은 지운다(재전송)
 *   ② (PGTEST_URL) 인트라넷 옵션·상품(옵션 없는 상품·옵션 있는 상품) 이름 바꾸기 → 공고 줄·참여 기록·빈 줄 · 채운 줄 그대로 ·
 *      겹치는 이름 거부 · 옛 창 거부 · 마감 줄 거부 · 이름+인원 함께 · 공고 창 옵션·상품 이름 바꾸기 → 오더 · 일부 줄만 상품 이름 = 못 정함
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
  const SP = require('../src/services/sharedPatch.service');
  const P = JSON.parse(JSON.stringify(OPT_PRODUCTS));
  const base = { product_options_json: JSON.stringify(P) };
  const mine = JSON.parse(JSON.stringify(P)); mine[0].options[1] = { ...mine[0].options[1], prev_label: '화이트', label: '화이트2', option_1: { name: '', value: '화이트2' } };
  assert.deepEqual([...SP.renamedParents({ product_options_json: JSON.stringify(mine) })], ['p:탈취제|o:화이트']);
  const stale = JSON.parse(JSON.stringify(P)); stale[0].options[1].prev_label = 'ZZZ'; stale[1].prev_name = '없는 상품';
  const cleaned = JSON.parse(SP.sanitizeRenames(base, { product_options_json: JSON.stringify(stale) }).product_options_json);
  assert.equal(cleaned[0].options[1].prev_label, undefined, '기준에 없는 원래 이름 = 이름 바꾸기 아님'); assert.equal(cleaned[1].prev_name, undefined);
  const kept = SP.sanitizeRenames(base, { product_options_json: JSON.stringify(mine) });
  assert.equal(JSON.parse(kept.product_options_json)[0].options[1].prev_label, '화이트');
}
console.log('bidirPhase7Rename: static passed');

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
  const SHEET = 'sheet_p7r';
  /** 인트라넷 오더 + 발행 그대로인 공고(옵션 줄) + 무시트 작업표(총모집만큼 빈 줄, 옵션 배정 표식) + 연결(link=false 면 연결 안 함). */
  const setup = async (tag, { link = true, extra = {} } = {}) => {
    const sid = `ro_p7r_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7r_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7r_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(OPT_PRODUCTS);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 이름 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
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
    const intranet = async (patch, { structure = true, rename = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: structure, renameCapable: rename });
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
    const ren = (x, pName, from, to) => { const o = x.find(p => p.name === pName).options.find(y => y.label === from);
      o.prev_label = from; o.label = to; o.option_1 = { ...(o.option_1 || {}), value: to }; };
    // 작업표: 화이트 빈 줄 + 화이트 채운 줄(산 사람) · 화이트 신청 2명
    const rows0 = await A.rows();
    const filled = rows0.find(x => x.option_text === '화이트');
    await pool.query(`UPDATE campaign_participants SET reviewer_name = '가짜구매', row_json = '{"옵션":"화이트"}'::jsonb WHERE id = $1`, [filled.id]);
    await A.apply({ key: '화이트', count: 2 });

    // R1 인트라넷 옵션 이름 바꾸기 + 인원 함께
    let out = await A.intranet(edited(await A.wo(), x => { ren(x, '탈취제', '화이트', '화이트(신형)'); x[0].options.find(y => y.label === '화이트(신형)').count = 13; }), { rename: true });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    let o = await A.opts();
    assert.ok(!o.has('화이트') && o.get('화이트(신형)'), '공고 줄 이름'); assert.equal(Number(o.get('화이트(신형)').recruit_total), 13);
    const apps = (await pool.query(`SELECT option_key, count(*)::int n FROM campaign_applications WHERE campaign_id = $1 GROUP BY 1`, [A.camp])).rows;
    assert.deepEqual(apps, [{ option_key: '화이트(신형)', n: 2 }], '참여 기록도 새 이름');
    const rows1 = await A.rows();
    assert.equal(rows1.find(x => x.id === filled.id).option_text, '화이트', '채운 줄은 산 당시 이름(완화 금지)');
    assert.equal(rows1.find(x => x.id === filled.id).row_json['옵션'], '화이트');
    assert.ok(rows1.filter(x => x.id !== filled.id && x.option_text === '화이트(신형)').length >= 11, '빈 줄은 새 이름');
    assert.ok(!rows1.some(x => x.id !== filled.id && x.option_text === '화이트'), '빈 줄에 옛 이름이 남지 않는다');
    assert.ok(rows1.filter(x => x.option_text === '화이트(신형)').every(x => x.row_json['옵션'] === '화이트(신형)'), '빈 줄 옵션 칸도 새 이름');
    const p1 = await A.prods();
    assert.equal(p1[0].options[1].label, '화이트(신형)'); assert.equal(p1[0].options[1].prev_label, undefined, '원래 이름은 저장하지 않는다');
    assert.equal(Number((await A.cRow()).recruit_total), 21);

    // R2 옵션 없는 상품 이름 바꾸기 → 공고 줄 이름(=상품 이름)·상품 이름·빈 줄
    out = await A.intranet(edited(await A.wo(), x => { const p = x.find(y => y.name === '두번째'); p.prev_name = '두번째'; p.name = '두번째 리뉴얼'; }), { rename: true });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    o = await A.opts();
    assert.ok(!o.has('두번째') && o.get('두번째 리뉴얼')); assert.equal(o.get('두번째 리뉴얼').product_name, '두번째 리뉴얼');
    assert.ok((await A.rows()).filter(x => x.option_text === '두번째 리뉴얼').length === 3);

    // R3 옵션 있는 상품 이름 바꾸기 → 줄 이름 그대로 · 상품 이름만
    out = await A.intranet(edited(await A.wo(), x => { const p = x.find(y => y.name === '탈취제'); p.prev_name = '탈취제'; p.name = '탈취제 플러스'; }), { rename: true });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    o = await A.opts();
    assert.equal(o.get('블랙').product_name, '탈취제 플러스'); assert.equal(o.get('화이트(신형)').product_name, '탈취제 플러스');

    // R4 겹치는 이름 · R5 옛 창 · R6 재전송(기준에 없는 원래 이름)
    const s0 = await A.snap();
    out = await A.intranet(edited(await A.wo(), x => ren(x, '탈취제 플러스', '블랙', '화이트(신형)')), { rename: true });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'structure_rename_conflict', JSON.stringify(out.body)); assert.equal(await A.snap(), s0);
    out = await A.intranet(edited(await A.wo(), x => ren(x, '탈취제 플러스', '블랙', '블랙2')), { rename: false });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'field_not_editable', JSON.stringify(out.body)); assert.equal(await A.snap(), s0);
    out = await A.intranet(edited(await A.wo(), x => { x[0].options[0].prev_label = '예전블랙'; }), { rename: true });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.deepEqual(out.body.applied || [], [], '재전송된 원래 이름 = 바꿀 것 없음');

    // R7 공고 창 옵션 이름 바꾸기 → 오더
    let r = await put(b => { const x = b.options.find(y => y.optKey === '블랙'); x.optKey = '블랙 매트'; });
    ok(r, '공고 창 옵션 이름');
    assert.ok((await A.prods())[0].options.some(y => y.label === '블랙 매트' && y.option_1.value === '블랙 매트'));
    assert.ok((await A.opts()).has('블랙 매트'));
    assert.ok(/블랙 매트/.test(String((await A.wo()).product_option || '')), '상품 요약 문장도 새 이름: ' + (await A.wo()).product_option);
    // R8 공고 창 상품 이름 — 일부 줄만 = 못 정함 · 모든 줄 = 오더 상품 이름
    r = await put(b => { b.options.find(y => y.optKey === '블랙 매트').productName = '탈취제 맥스'; });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'campaign_field_unmappable');
    r = await put(b => { b.options.filter(y => y.productName === '탈취제 플러스').forEach(y => { y.productName = '탈취제 맥스'; }); });
    ok(r, '공고 창 상품 이름(모든 줄)');
    assert.equal((await A.prods())[0].name, '탈취제 맥스'); assert.equal((await A.opts()).get('블랙 매트').product_name, '탈취제 맥스');

    // R9 마감 줄 이름 바꾸기 = 못 바꿈
    await A.apply({ key: '블랙 매트', count: 1 });
    r = await put(b => { b.options = b.options.filter(y => y.optKey !== '블랙 매트'); b.recruit_total = sum(b, 'recruitTotal'); b.daily_limit = sum(b, 'dailyLimit'); });
    ok(r, '블랙 매트 지움 → 마감');
    const s9 = await A.snap();
    out = await A.intranet(edited(await A.wo(), x => ren(x, '탈취제 맥스', '블랙 매트', '블랙 X')), { rename: true });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(await A.snap(), s9);
    // ══ 재검토 2026-10-21 ══ (지금: 탈취제 맥스 = 블랙 매트(마감·1) · 화이트(신형) · 두번째 리뉴얼)
    const sB = await A.snap();
    const conflict = async (label, fn) => {
      const o2 = await A.intranet(edited(await A.wo(), fn), { rename: true });
      assert.equal(o2.status, 409, label + ': ' + JSON.stringify(o2.body)); assert.equal(await A.snap(), sB, label + ' — 쓰기 0');
      return o2.body;
    };
    // 맞바꾸기 · 이어 바꾸기 · 지우는 옵션 이름 쓰기 · 이름 바꾸고 같은 이름 새로 더하기
    await A.intranet(edited(await A.wo(), x => x[0].options.push({ option_1: { name: '옵션', value: '그레이' }, label: '그레이', url: '', pay: 1000, count: 2, daily: 1, review_type_mix: [] })), { rename: true });
    const sB2 = await A.snap();
    let cb = await A.intranet(edited(await A.wo(), x => { ren(x, '탈취제 맥스', '화이트(신형)', '그레이'); ren(x, '탈취제 맥스', '그레이', '화이트(신형)'); }), { rename: true });
    assert.equal(cb.status, 409, JSON.stringify(cb.body)); assert.equal(cb.body.code, 'structure_rename_conflict'); assert.equal(await A.snap(), sB2, '맞바꾸기 쓰기 0');
    cb = await A.intranet(edited(await A.wo(), x => { ren(x, '탈취제 맥스', '화이트(신형)', '그레이'); ren(x, '탈취제 맥스', '그레이', '실버'); }), { rename: true });
    assert.equal(cb.body.code, 'structure_rename_conflict', '이어 바꾸기: ' + JSON.stringify(cb.body)); assert.equal(await A.snap(), sB2);
    cb = await A.intranet(edited(await A.wo(), x => { ren(x, '탈취제 맥스', '화이트(신형)', '그레이'); x[0].options = x[0].options.filter(y => y.prev_label || y.label !== '그레이'); }), { rename: true });
    assert.equal(cb.body.code, 'structure_rename_conflict', '지우는 옵션 이름 쓰기: ' + JSON.stringify(cb.body)); assert.equal(await A.snap(), sB2);
    cb = await A.intranet(edited(await A.wo(), x => { ren(x, '탈취제 맥스', '그레이', '실버');
      x[0].options.push({ option_1: { name: '옵션', value: '그레이' }, label: '그레이', url: '', pay: 1000, count: 1, daily: 0, review_type_mix: [] }); }), { rename: true });
    assert.equal(cb.body.code, 'structure_rename_conflict', '이름 바꾸고 같은 이름 더하기: ' + JSON.stringify(cb.body)); assert.equal(await A.snap(), sB2);
    // 마감 줄을 다시 열면서 이름 바꾸기 = 못 함
    cb = await A.intranet(edited(await A.wo(), x => { const y = x[0].options.find(z => z.label === '블랙 매트'); delete y.closed; y.count = 4; ren(x, '탈취제 맥스', '블랙 매트', '블랙 새것'); }), { rename: true });
    assert.equal(cb.status, 409, JSON.stringify(cb.body)); assert.equal(await A.snap(), sB2);
    // 상품 이름 바꾸기 + 참여자 있는 옵션 지우기 한 번에 = 마감으로 되살림(막다른 길 아님)
    await A.apply({ key: '그레이', count: 1 });
    out = await A.intranet(edited(await A.wo(), x => { x[0].prev_name = '탈취제 맥스'; x[0].name = '탈취제 울트라'; x[0].options = x[0].options.filter(y => y.label !== '그레이'); }), { rename: true });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const pu = (await A.prods())[0];
    assert.equal(pu.name, '탈취제 울트라'); assert.equal(pu.options.find(y => y.label === '그레이').closed, true);
    assert.equal((await A.opts()).get('그레이').status, 'closed'); assert.equal((await A.opts()).get('그레이').product_name, '탈취제 울트라');
    // 공고 창 맞바꾸기 = 못 정함 · 마감 줄이 섞인 상품의 상품 이름만 바꾸기 = 됨
    r = await put(b => { const a1 = b.options.find(y => y.optKey === '화이트(신형)'); a1.optKey = '두번째 리뉴얼'; const a2 = b.options.find(y => y.optKey === '두번째 리뉴얼' && y !== a1); if (a2) a2.optKey = '화이트(신형)'; });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    r = await put(b => { b.options.filter(y => y.productName === '탈취제 울트라').forEach(y => { y.productName = '탈취제 프로'; }); });
    ok(r, '마감 줄 섞인 상품 이름');
    assert.equal((await A.prods())[0].name, '탈취제 프로'); assert.equal((await A.opts()).get('블랙 매트').product_name, '탈취제 프로');
    console.log('bidirPhase7Rename: PG passed');
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
  console.log('bidirPhase7Rename: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
