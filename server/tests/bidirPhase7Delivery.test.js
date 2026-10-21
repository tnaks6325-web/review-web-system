/**
 * 양방향 7단계-④ ⑤ 배송 한 종류 바꾸기(결정 263 · 사용자 확정 2026-10-21 「1.나」).
 *   실배송·빈박스·택배발송대행·직접배송(가구 등)끼리 → 오더(택배대행 표시 같이) · 공고 배송 · 탭 설정 · 작업표 송장 칸(들어가면 더함 · 나오면 송장 없을 때만 뺌).
 *   혼합·회수가 끼는 변경 · 블로그는 막힘(접수 뒤 영구 금지).
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');


const OPT_PRODUCTS = [
  { name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] },
  { name: '두번째', url: 'https://smartstore.naver.com/x/products/9', option_schema_version: 2, product_mode: 'none',
    base: { pay: 9000, count: 3, daily: 1, review_type_mix: [] }, options: [] },
];

{
  const SP = require('../src/services/sharedPatch.service');
  const { ABSENT } = require('../src/utils/sharedPatchPlan');
  const row = (b, m) => ({ meta: { kind: 'field', key: 'delivery_type' }, base: b, mine: m });
  assert.ok(SP.writablePath(row('실배송', '빈박스'), 'intranet'));
  assert.ok(SP.writablePath(row('빈박스', '택배발송대행'), 'campaign'));
  assert.ok(SP.writablePath(row('택배발송대행', '직접배송(가구 등)'), 'intranet'));
  assert.ok(!SP.writablePath(row('실배송', '혼합(실배송 1건, 빈박스 2건)'), 'intranet'), '혼합으로는 못 감');
  assert.ok(!SP.writablePath(row('회수(회수택배사: A)', '실배송'), 'intranet'), '회수에서는 못 옴');
  assert.ok(!SP.writablePath(row('실배송', '빈박스'), 'rw_admin'), '관리자 오더 수정은 아직');
  assert.ok(!SP.writablePath(row('실배송', ABSENT), 'intranet'));
  assert.ok(SP.deliverySwapOpen({ delivery_type: '빈박스', delivery_type_mix: [], work_kind: '' }));
  assert.ok(!SP.deliverySwapOpen({ delivery_type: '실배송', delivery_type_mix: [], work_kind: 'blog' }));
  assert.ok(!SP.deliverySwapOpen({ delivery_type: '혼합(실배송 1건, 빈박스 2건)', delivery_type_mix: [{ type: 'real', quantity: 1 }, { type: 'empty', quantity: 2 }] }));
  assert.ok(SP.PUSH_VIEW_KEYS.includes('delivery_type'));
  const T = require('../src/services/worktableTrackingColumn.service');
  assert.deepEqual(T.withTrackingColumn(['번호', '구매일자', '주문번호', '비고', '리뷰'], true).headers, ['번호', '구매일자', '주문번호', '비고', '송장번호', '리뷰'], '새 판 = 비고 뒤');
  assert.deepEqual(T.withTrackingColumn(['번호', '구매일자', '리뷰'], false).headers, ['번호', '구매일자', '리뷰', '택배송장번호'], '옛 판 = 맨 뒤');
  // 옛 판은 정규식(택배+송장)만 · 새 판은 분류(송장번호)만 — 섞으면 옛 판 틀의 「송장번호」를 송장 칸으로 읽는다(검토 2026-10-21)
  assert.deepEqual(T.trackingHeaders(['번호', '택배송장번호', '송장번호', '비고']), ['택배송장번호']);
  assert.deepEqual(T.trackingHeaders(['번호', '구매일자', '주문번호', '비고', '송장번호'], true), ['송장번호']);
  const E = require('../src/utils/campaignSharedEdit');
  const ch = E.structureChangesFromCampaign({ camp: { delivery_type: '실배송' }, store: { delivery_type: '빈박스' } });
  assert.deepEqual(ch, [{ label: '배송 방식', permanent: false }]);
}
console.log('bidirPhase7Delivery: static passed');

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
  const SHEET = 'sheet_p7d';
  /** 인트라넷 오더 + 발행 그대로인 공고(옵션 줄) + 무시트 작업표(총모집만큼 빈 줄, 옵션 배정 표식) + 연결(link=false 면 연결 안 함). */
  const setup = async (tag, { link = true, extra = {} } = {}) => {
    const sid = `ro_p7d_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7d_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7d_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(OPT_PRODUCTS);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 배송 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
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
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, delivery_type, taekhap, updated_at) VALUES ($1, $2, $3, TRUE, $4, FALSE, NOW())`, [SHEET, tab, 'g' + tag + stamp, extra.delivery_type || '실배송']);
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
    const intranet = async (patch, { structure = true, rename = true, reviewtype = true, delivery = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: structure, renameCapable: rename, reviewTypeCapable: reviewtype, deliveryCapable: delivery });
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

    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    const ok = (r, label) => { assert.equal(r.status, 200, label + ': ' + JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, label + ': ' + JSON.stringify(r.body)); };
    const put = async (fn, camp) => { const b = await openBody(camp); fn(b); return call('PUT', `/api/campaign/admin/${camp}`, b, admin); };
    const { rebuildLedgers } = require('../src/services/sheetlessLedger.service');
    const tabOf = async X => (await pool.query('SELECT delivery_type, taekhap FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [SHEET, X.tab])).rows[0];
    const heads = async X => {
      const g = (await pool.query('SELECT tab_gid FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [SHEET, X.tab])).rows[0].tab_gid;
      const r = (await pool.query('SELECT headers FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2', [SHEET, g])).rows[0];
      return r ? r.headers : null;
    };

    const A = await setup('a');
    await rebuildLedgers({ sheetId: SHEET, tabName: A.tab, dryRun: false, by: 'test' });   // 장부(머리글) 먼저 — 접수 뒤 상태
    const h0 = await heads(A);
    assert.ok(Array.isArray(h0) && h0.length && !h0.includes('택배송장번호'), JSON.stringify(h0));

    // D1 실배송 → 빈박스 — 오더·공고·탭 설정(배송·택배대행) · 송장 칸 그대로
    let out = await A.intranet({ delivery_type: '빈박스' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    let w = await A.wo();
    assert.equal(w.delivery_type, '빈박스'); assert.equal(w.courier_proxy, false);
    assert.equal((await A.cRow()).delivery_type, '빈박스');
    assert.deepEqual(await tabOf(A), { delivery_type: '빈박스', taekhap: false });
    assert.deepEqual(await heads(A), h0);

    // D2 빈박스 → 택배발송대행 — 택배대행 표시 켜짐 · 옛 판 송장 칸(택배송장번호)을 맨 뒤에 더함
    out = await A.intranet({ delivery_type: '택배발송대행' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    w = await A.wo();
    assert.equal(w.delivery_type, '택배발송대행'); assert.equal(w.courier_proxy, true);
    assert.equal((await A.cRow()).delivery_type, '택배발송대행');
    assert.deepEqual(await tabOf(A), { delivery_type: '택배발송대행', taekhap: true });
    let h = await heads(A);
    assert.equal(h[h.length - 1], '택배송장번호', JSON.stringify(h)); assert.equal(h.length, h0.length + 1);

    // D3 택배발송대행 → 실배송 — 송장이 하나도 없으면 칸을 뺀다
    out = await A.intranet({ delivery_type: '실배송' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await A.wo()).courier_proxy, false);
    assert.deepEqual(await heads(A), h0);

    // D4 다시 택배발송대행 → 송장 하나 적힘(업체 편집 기록) → 직접배송 — 칸은 남는다(적힌 송장을 지우지 않는다)
    out = await A.intranet({ delivery_type: '택배발송대행' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const row1 = (await A.rows())[0];
    await pool.query(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by) VALUES ($1, $2, 'manual', $3, 'col:택배송장번호', 'text', '512345678901', '업체')`, [SHEET, A.tab, String(row1.id)]);
    out = await A.intranet({ delivery_type: '직접배송(가구 등)' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    w = await A.wo();
    assert.equal(w.delivery_type, '직접배송(가구 등)'); assert.equal(w.courier_proxy, false);
    assert.equal((await A.cRow()).delivery_type, '직접배송(가구 등)');
    assert.ok((await heads(A)).includes('택배송장번호'), '송장이 적힌 칸은 남는다');
    // 줄 값으로 적힌 송장도 같은 규칙(편집 기록을 되돌려도 줄 값이 있으면 남음)
    await pool.query(`UPDATE participant_edits SET reverted_at = NOW() WHERE sheet_id = $1 AND tab_name = $2`, [SHEET, A.tab]);
    await pool.query(`UPDATE campaign_participants SET row_json = row_json || '{"택배송장번호":"777"}'::jsonb WHERE id = $1`, [row1.id]);
    out = await A.intranet({ delivery_type: '택배발송대행' }); assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await heads(A)).filter(x => x === '택배송장번호').length, 1, '이미 있으면 다시 더하지 않는다');
    out = await A.intranet({ delivery_type: '실배송' }); assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok((await heads(A)).includes('택배송장번호'));

    // D5 혼합·회수로 가는 변경은 막힌다(접수 뒤 영구 금지) — 아무것도 안 바뀜
    const s5 = await A.snap();
    out = await A.intranet({ delivery_type: '혼합(실배송 10건, 빈박스 12건)', delivery_type_mix: [{ type: 'real', quantity: 10 }, { type: 'empty', quantity: 12 }] });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'structure_new_order'); assert.match(out.body.error, /새 리뷰오더/); assert.equal(await A.snap(), s5);
    out = await A.intranet({ delivery_type: '회수(회수택배사: CJ, 회수상품명칭: 가짜)', recall_courier: 'CJ', recall_product: '가짜' });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'structure_new_order'); assert.equal(await A.snap(), s5);

    // D6 배송을 모르는 옛 인트라넷 창 — 잠긴 배송 칸의 옛 사본 값(빈박스)을 다시 보내도 받지 않는다(다른 칸은 저장)
    out = await A.intranet({ delivery_type: '빈박스', special_notes: '옛 창 저장' }, { delivery: false });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await A.wo()).delivery_type, '실배송'); assert.equal((await A.wo()).special_notes, '옛 창 저장');

    // D7 블로그 작업은 배송을 못 바꾼다(실배송 고정)
    const B = await setup('b');
    await pool.query(`UPDATE work_orders SET work_kind = 'blog' WHERE id = $1`, [B.w.id]);
    await pool.query(`UPDATE work_order_shared_snapshots SET state = state || '{"work_kind":"blog"}'::jsonb WHERE work_order_id = $1`, [B.w.id]);
    const sB = await B.snap();
    out = await B.intranet({ delivery_type: '빈박스' });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'delivery_locked'); assert.equal(await B.snap(), sB);

    // D8 수정 창 잠금 해제 목록 — 한 종류 배송이면 열고, 블로그면 닫는다
    const sh = async (X, q = '?caps=delivery') => (await call('GET', `/api/order/intake/source/${X.sid}/shared${q}`)).body;
    assert.ok((await sh(A)).writable.includes('delivery_type'));
    assert.ok(!(await sh(B)).writable.includes('delivery_type'));
    // 배송을 모르는 옛 인트라넷(caps 없음)에는 열지 않는다 — 옛 창은 배송 칸 하나로 혼합·회수까지 함께 잠근다(배포 순서 안전장치)
    assert.ok(!(await sh(A, '')).writable.includes('delivery_type'));
    assert.ok((await sh(A, '')).writable.includes('review_fee'), '다른 칸은 그대로');

    // D9 공고 창 — 배송 한 종류 바꾸기는 공유 저장으로(오더·탭 설정·송장 칸까지) · 혼합으로는 새 리뷰오더 안내
    const C = await setup('c');
    await rebuildLedgers({ sheetId: SHEET, tabName: C.tab, dryRun: false, by: 'test' });
    let r = await put(b => { b.delivery_type = '택배발송대행'; }, C.camp);
    ok(r, '공고 창 배송');
    assert.equal((await C.wo()).delivery_type, '택배발송대행'); assert.equal((await C.wo()).courier_proxy, true);
    assert.equal((await C.cRow()).delivery_type, '택배발송대행');
    assert.deepEqual(await tabOf(C), { delivery_type: '택배발송대행', taekhap: true });
    assert.ok((await heads(C)).includes('택배송장번호'));
    const sC = await C.snap();
    r = await put(b => { b.delivery_type = '혼합'; b.delivery_type_mix = [{ type: 'real', quantity: 10 }, { type: 'empty', quantity: 10 }]; b.delivery_review_fee_mix = [{ type: 'real', reviewFee: 1000 }, { type: 'empty', reviewFee: 1000 }]; }, C.camp);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'structure_new_order'); assert.equal(await C.snap(), sC);

    // D10 오더·공고가 이미 갈라진 공고 — 공고 값을 오더 값으로 되돌리면 공고만 맞춘다(오더 버전 그대로)
    const F = await setup('f');
    await pool.query(`UPDATE recruit_campaigns SET delivery_type = '빈박스' WHERE id = $1`, [F.camp]);
    const vF = Number((await F.wo()).sync_version);
    r = await put(b => { b.delivery_type = '실배송'; }, F.camp);
    ok(r, '공고 창 배송 되돌리기');
    assert.equal((await F.cRow()).delivery_type, '실배송'); assert.equal(Number((await F.wo()).sync_version), vF, '오더는 그대로');

    // D12 다른 공고(마감 포함 · 보관 안 함)와 같이 쓰는 작업표 — 탭 설정·송장 칸이 하나라 배송을 못 바꾼다(아무것도 안 바뀜)
    const G = await setup('g');
    const other = `camp_p7d_g2_${stamp}`; camps.push(other);
    await pool.query(`INSERT INTO recruit_campaigns (id, title, recruit_total, review_fee, participation_mode, status, linked_sheet_id, linked_tab_name)
                       VALUES ($1, '같은 탭 1차', 5, 1000, TRUE, 'closed', $2, $3)`, [other, SHEET, G.tab]);
    const sG = await G.snap(); const tG = await tabOf(G);
    out = await G.intranet({ delivery_type: '택배발송대행' });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.reason, 'delivery_shared_tab'); assert.match(out.body.error, /같이 써서/);
    assert.equal(await G.snap(), sG); assert.deepEqual(await tabOf(G), tG);
    await pool.query(`UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1`, [other]);   // 보관한 공고는 같이 쓰는 것으로 안 본다
    out = await G.intranet({ delivery_type: '빈박스' });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal((await G.wo()).delivery_type, '빈박스');

    // D11 리뷰어 앱(범위 편집)의 배송 바꾸기는 종전대로 막힌다
    const sc = await call('PUT', `/api/campaign/admin/${A.camp}`, { delivery_type: '빈박스' }, scoped);
    assert.equal(sc.status, 409, JSON.stringify(sc.body)); assert.equal(sc.body.code, 'shared_field_scoped');
    console.log('bidirPhase7Delivery: PG passed');
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
  console.log('bidirPhase7Delivery: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
