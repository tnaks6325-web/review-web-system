/**
 * 양방향 7단계-④ ⑤-2 옵션 없이 상품 하나로 도는 공고(공고 옵션 줄 0개) 열기(결정 275 · 사용자 확정 2026-10-21 「2.가」).
 *   상품을 더하면 저장 때 원래 상품 줄을 먼저 만들고(발행 프리필 값) · 옵션 없이 참여한 기록을 그 줄 몫으로 옮기고 ·
 *   공고 전체 품절 멈춤·신고·알림을 그 줄로 옮긴 뒤, 이미 있는 더하기·지우기(마감) 처리를 그대로 탄다.
 *   상품 안내 글(리뷰어 작업 안내의 「상품」)은 사람이 고치지 않았으면 새 구성으로 다시 쓴다.
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');

const SINGLE = [{ name: '단일상품', url: 'https://smartstore.naver.com/x/products/1', option_schema_version: 2, product_mode: 'none',
  base: { pay: 13000, count: 20, daily: 4, review_type_mix: [] }, options: [] }];
const OPT_P = { name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
  { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
  { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] };
const PROD_B = { name: '새상품', url: 'https://smartstore.naver.com/x/products/2', option_schema_version: 2, product_mode: 'none',
  base: { pay: 9000, count: 5, daily: 1, review_type_mix: [] }, options: [] };

{
  // 정적 — 열림 판정 단일 출처(상품 하나짜리면 옵션 줄 0개여도 연다)
  const src = require('fs').readFileSync(require.resolve('../src/services/sharedPatch.service'), 'utf8');
  assert.match(src, /return rows\.length > 0 \|\| !!_soleProductUnit\(st\);/);
  assert.ok(src.indexOf('adopted = await _adoptSoleProductInTx(client, camp, theirs);') < src.indexOf('closure = await _closeRemovedInTx(client, camp, theirs, next, structure);'),
    '원래 상품 줄을 먼저 만든다(마감 판정이 그 줄의 참여 수를 읽는다)');
  // ⑤-2 보완(사용자 확정 「1.보완」) — 원래 상품 줄 시각(sole_until) 전에 들어온 바로 구매는 표기와 무관하게 그 상품
  const { matchOrderOption } = require('../src/services/campaignState.service');
  const T0 = '2026-10-21T05:00:00.000Z';
  const rows = [{ opt_key: '단일상품', product_name: '단일상품', sole_until: T0 }, { opt_key: '새상품', product_name: '새상품', sole_until: null }];
  assert.equal(matchOrderOption(rows, { selectedProduct: '전혀 다른 표기 1개', submittedAt: '2026-10-21T04:00:00Z' }), '단일상품', '그 전 = 원래 상품');
  assert.equal(matchOrderOption(rows, { selectedProduct: '새상품', submittedAt: new Date('2026-10-21T04:00:00Z') }), '단일상품', '그 전엔 새 상품이 없었다');
  assert.equal(matchOrderOption(rows, { selectedProduct: '전혀 다른 표기 1개', submittedAt: '2026-10-21T06:00:00Z' }), null, '그 뒤 = 종전(이름으로만)');
  assert.equal(matchOrderOption(rows, { selectedProduct: '새상품', submittedAt: '2026-10-21T06:00:00Z' }), '새상품');
  assert.equal(matchOrderOption(rows, { selectedProduct: '전혀 다른 표기 1개' }), null, '시각 모름 = 종전');
  assert.equal(matchOrderOption(rows, { editedProduct: '새상품', submittedAt: '2026-10-21T04:00:00Z' }), '새상품', '사람이 고친 상품 칸이 먼저(결정 232)');
  assert.equal(matchOrderOption(rows, { editedProduct: '엉뚱', submittedAt: '2026-10-21T04:00:00Z' }), '단일상품', '고친 값이 안 맞으면 그때 하나뿐이던 상품');
}
console.log('bidirPhase7SoleProduct: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const SP = require('../src/services/sharedPatch.service');
  const { linkSharedOrder, applySharedPatch, readSharedState, structureOpenFor, STRUCTURE_FIELD } = SP;
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const jwt = require('jsonwebtoken');
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
  const SHEET = 'sheet_p7sp';
  /** 인트라넷 오더(상품 하나 · 옵션 없음) + 옵션 줄 없는 공고 + 무시트 작업표(총모집만큼 빈 줄) + 연결. */
  const setup = async (tag, products = SINGLE) => {
    const sid = `ro_p7sp_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7sp_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_p7sp_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(products);
    const total = products.reduce((a, p) => a + p.base.count, 0);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 상품 하나 ' + tag, recruit_count: total, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: products[0].url,
      inflow_type: 'link', purchase_channel: '스마트스토어', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: products.reduce((a, p) => a + p.base.pay * p.base.count, 0) });
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
    // 옵션 있는 상품이 있으면 발행 그대로 옵션 줄 · 없으면 옵션 줄 없음(운영의 옵션 없는 공고 16개 중 7개와 같은 모양)
    if (products.some(x => x.product_mode === 'opt')) {
      for (const o of proj.options) {
        const [pName, oKey] = o.key.split('|');
        await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
          [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
      }
    }
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, delivery_type, taekhap, updated_at) VALUES ($1, $2, $3, TRUE, '실배송', FALSE, NOW())`, [SHEET, tab, 'g' + tag + stamp]);
    for (let i = 1; i <= total; i++) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, option_text, source, updated_by, updated_at)
                        VALUES ($1, $2, $3, '{}'::jsonb, '', 'worktable', '시험', NOW())`, [SHEET, tab, i]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query(`SELECT * FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'deleted' ORDER BY id`, [camp])).rows;
    const apps = async () => (await pool.query(`SELECT option_key, COUNT(*)::int AS n FROM campaign_applications WHERE campaign_id = $1 GROUP BY option_key ORDER BY option_key NULLS FIRST`, [camp])).rows;
    const rows = async () => (await pool.query(`SELECT id, seq, option_text FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active ORDER BY seq`, [SHEET, tab])).rows;
    let phoneSeq = 0;
    /** 옵션 없이 참여(option_key 없음 — 옵션 없는 공고의 참여 모양). */
    const applyNone = (n) => { const from = phoneSeq; phoneSeq += n;
      return pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at)
        SELECT $1, '가짜참여' || g, lpad((7300000 + $3 + g)::text, 8, '0'), 'applied', NULL, NOW() + INTERVAL '1 hour' FROM generate_series(1, $2) g`, [camp, n, from]); };
    const applyKey = (key, n) => { const from = phoneSeq; phoneSeq += n;
      return pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at)
        SELECT $1, '가짜참여' || g, lpad((7400000 + $4 + g)::text, 8, '0'), 'applied', $2, NOW() + INTERVAL '1 hour' FROM generate_series(1, $3) g`, [camp, key, n, from]); };
    const intranet = async (patch, { mode = true } = {}) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: true, renameCapable: true,
        reviewTypeCapable: true, deliveryCapable: true, modeCapable: mode });
    };
    const snap = async () => JSON.stringify([(await wo()).sync_version, (await wo()).product_options_json, await opts(), await apps(), (await cRow()).recruit_total]);
    return { sid, camp, tab, w, wo, cRow, opts, apps, rows, applyNone, applyKey, intranet, snap };
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
  /** 공고 창을 연 모양 그대로의 저장 본문(Delivery 시험과 같은 규칙). */
  const openBody = async (camp) => {
    const dd = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
    const c0 = dd.body.data;
    return { title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
      work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
      channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
      recruit_total: c0.recruit_total, daily_limit: c0.daily_limit,
      delivery_type: c0.delivery_type, review_type: c0.review_type, work_kind: c0.work_kind || 'review',
      options: (dd.body.options || []).map(x => ({ optKey: x.optKey, prevOptKey: x.optKey, productName: x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
        recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
      fee_schedules: (dd.body.feeSchedules || []).map(x => ({ effectiveFrom: x.effectiveFrom, reviewFee: x.reviewFee, memo: x.memo })),
      bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined };
  };
  const put = async (camp, fn) => { const b = await openBody(camp); fn(b); return call('PUT', `/api/campaign/admin/${camp}`, b, admin); };
  const prodRow = (name, url, pay, rt, dl) => ({ optKey: name, prevOptKey: '', productName: name, unitKind: 'product', optionUrl: url, payAmount: pay,
    recruitTotal: rt, dailyLimit: dl, status: 'active', inflowGuideHtml: '', inflowGuideImages: [] });
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    // S1 열림 판정 — 옵션 줄 0개여도 상품 하나짜리면 상품·옵션 더하기를 연다(수정 창 잠금 해제 목록에도)
    const A = await setup('a');
    assert.equal((await A.opts()).length, 0);
    assert.equal(await structureOpenFor(pool, await A.wo()), true);
    const sh = (await call('GET', `/api/order/intake/source/${A.sid}/shared?caps=delivery`)).body;
    assert.ok(sh.writable.includes(STRUCTURE_FIELD), JSON.stringify(sh.writable));

    // S2 참여 3명(옵션 없음) · 공고 전체 품절 멈춤 · 품절 신고 1건이 있는 상태에서 상품 더하기
    await A.applyNone(3);
    await pool.query(`UPDATE recruit_campaigns SET soldout_paused_at = NOW() - INTERVAL '1 hour', soldout_paused_reason = 'manual', soldout_paused_by = '담당자' WHERE id = $1`, [A.camp]);
    await pool.query(`INSERT INTO campaign_option_soldout_reports (campaign_id, opt_key, order_submission_id, reporter) VALUES ($1, '', $2, '73000001')`, [A.camp, `os_p7sp_${stamp}`]);
    await pool.query(`INSERT INTO campaign_option_alerts (campaign_id, opt_key, kind, report_count) VALUES ($1, '', 'soldout_report', 1)`, [A.camp]);
    const lines0 = String((await A.cRow()).work_detail.productLines || '');
    assert.ok(lines0.includes('단일상품') && !lines0.includes('새상품'), lines0);
    let out = await A.intranet(edited(await A.wo(), p => p.push(JSON.parse(JSON.stringify(PROD_B)))));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    let o = await A.opts();
    assert.deepEqual(o.map(x => [x.opt_key, x.unit_kind, x.status, Number(x.recruit_total), Number(x.pay_amount)]),
      [['단일상품', 'product', 'active', 20, 13000], ['새상품', 'product', 'active', 5, 9000]]);
    assert.ok(o[0].paused_at, '공고 전체 멈춤 → 원래 상품 줄 멈춤'); assert.equal(o[0].paused_reason, 'manual'); assert.equal(o[0].paused_by, '담당자');
    assert.ok(!o[1].paused_at, '새로 더한 상품은 열림');
    let c = await A.cRow();
    assert.equal(c.soldout_paused_at, null, '공고 전체 멈춤은 풀림(상품 줄로 옮김)');
    assert.equal(Number(c.recruit_total), 25);
    assert.deepEqual(await A.apps(), [{ option_key: '단일상품', n: 3 }], '옵션 없이 참여한 기록 → 원래 상품 몫');
    assert.equal((await pool.query(`SELECT opt_key FROM campaign_option_soldout_reports WHERE campaign_id = $1`, [A.camp])).rows[0].opt_key, '단일상품');
    assert.equal((await pool.query(`SELECT opt_key FROM campaign_option_alerts WHERE campaign_id = $1 AND resolved_at IS NULL`, [A.camp])).rows[0].opt_key, '단일상품');
    const lines1 = String(c.work_detail.productLines || '');
    assert.ok(lines1.includes('단일상품') && lines1.includes('새상품'), '상품 안내 글을 새 구성으로: ' + lines1);
    assert.equal((await A.rows()).length, 25);
    let w = await A.wo();
    assert.equal(JSON.parse(w.product_options_json).length, 2); assert.equal(Number(w.recruit_count), 25);

    // S3 원래 상품 지우기 — 참여 3명이 있어 지우지 않고 마감(인원 = 참여한 수) · 새 상품은 그대로
    out = await A.intranet(edited(await A.wo(), p => p.splice(0, 1)));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.closed_options, [{ pName: '단일상품', oLabel: '', used: 3 }]);
    o = await A.opts();
    assert.deepEqual(o.map(x => [x.opt_key, x.status]), [['단일상품', 'closed'], ['새상품', 'active']]);
    w = await A.wo();
    assert.equal(Number(w.recruit_count), 3 + 5);
    assert.equal(JSON.parse(w.product_options_json)[0].closed, true);

    // S4 참여자 없는 상품 하나짜리 공고 — 상품 바꾸기(원래 상품 지우고 새 상품) = 원래 줄 지움 · 새 줄만 남음(옵션 줄 0개로 돌아가지 않는다)
    const B = await setup('b');
    out = await B.intranet(edited(await B.wo(), p => { p.splice(0, 1, JSON.parse(JSON.stringify(PROD_B))); }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual((await B.opts()).map(x => [x.opt_key, x.status, Number(x.recruit_total)]), [['새상품', 'active', 5]]);
    assert.equal(Number((await B.cRow()).recruit_total), 5);

    // S5 구조를 안 건드리는 저장(인원만)은 옵션 없는 공고 그대로(줄을 만들지 않는다)
    const C = await setup('c');
    out = await C.intranet(edited(await C.wo(), p => { p[0].base.count = 22; }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await C.opts()).length, 0, '구조 저장이 아니면 줄을 만들지 않는다');
    assert.equal(Number((await C.cRow()).recruit_total), 22);

    // S6 다시 하나로 줄여도(더한 상품 지우기) 상품 줄 하나는 남는다(옵션 줄 0개로 돌아가지 않는다)
    const D = await setup('d');
    out = await D.intranet(edited(await D.wo(), p => p.push(JSON.parse(JSON.stringify(PROD_B)))));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    out = await D.intranet(edited(await D.wo(), p => p.splice(1, 1)));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual((await D.opts()).map(x => x.opt_key), ['단일상품']);
    assert.equal(await structureOpenFor(pool, await D.wo()), true);

    // S7 사람이 고친 상품 안내 글은 덮지 않는다
    const E = await setup('e');
    await pool.query(`UPDATE recruit_campaigns SET work_detail = work_detail || '{"productLines":"담당자가 직접 쓴 상품 안내"}'::jsonb WHERE id = $1`, [E.camp]);
    out = await E.intranet(edited(await E.wo(), p => p.push(JSON.parse(JSON.stringify(PROD_B)))));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await E.cRow()).work_detail.productLines, '담당자가 직접 쓴 상품 안내');
    // S8 공고 창 — 옵션 없는 공고를 "옵션 있음" 으로 바꿔 원래 상품 + 새 상품 → 공유 저장이 원래 줄을 만들고 새 줄을 더한다(오더까지)
    const F = await setup('f');
    await F.applyNone(2);
    let r = await put(F.camp, b => { assert.deepEqual(b.options, [], '옵션 없는 공고 = 옵션표 빈 목록');
      b.options = [prodRow('단일상품', SINGLE[0].url, 13000, 20, 4), prodRow('새상품', PROD_B.url, 9000, 5, 1)]; b.recruit_total = 25; b.daily_limit = 5; });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.deepEqual((await F.opts()).map(x => [x.opt_key, x.unit_kind, x.status, Number(x.recruit_total), Number(x.pay_amount)]),
      [['단일상품', 'product', 'active', 20, 13000], ['새상품', 'product', 'active', 5, 9000]]);
    assert.deepEqual(await F.apps(), [{ option_key: '단일상품', n: 2 }]);
    w = await F.wo();
    assert.deepEqual(JSON.parse(w.product_options_json).map(x => [x.name, x.base.count, x.base.pay]), [['단일상품', 20, 13000], ['새상품', 5, 9000]]);
    assert.equal(Number(w.recruit_count), 25);
    const lf = String((await F.cRow()).work_detail.productLines || '');
    assert.ok(lf.includes('새상품'), '공고 창 저장이 다시 쓴 상품 안내 글을 옛 글로 되덮지 않는다: ' + lf);

    // S9 원래 상품 줄을 빠뜨리거나 이름을 바꿔 보내면 막는다(참여 기록이 이어지지 않는다) — 아무것도 안 바뀜
    const G = await setup('g');
    const vG = Number((await G.wo()).sync_version);
    r = await put(G.camp, b => { b.options = [prodRow('새상품', PROD_B.url, 9000, 5, 1)]; b.recruit_total = 5; b.daily_limit = 1; });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'campaign_field_unmappable'); assert.match(r.body.error, /원래 상품\(「단일상품」\)/);
    assert.equal((await G.opts()).length, 0); assert.equal(Number((await G.wo()).sync_version), vG);

    // S10 옵션 없는 모드 그대로 저장(옵션표 빈 목록) = 구조 손대지 않음 — 줄을 만들지 않는다
    r = await put(G.camp, b => { b.title = '가짜 공고 제목만'; });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await G.opts()).length, 0); assert.equal(Number((await G.wo()).sync_version), vG);
    // ═══ ⑤-3 옵션 있음↔없음 ═══
    const toOpt = p => { p[0].product_mode = 'opt'; p[0].base = { ...p[0].base, pay: 0, count: 0, daily: 0 };
      p[0].options = [{ option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 13000, count: 12, daily: 2, review_type_mix: [] },
        { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 14000, count: 8, daily: 2, review_type_mix: [] }]; };
    // M1 옵션 없는 상품 하나짜리 공고(참여 0) → 옵션 있음: 원래 상품 줄은 지우고 옵션 줄 둘 · 오더 방식 opt
    const M = await setup('m1');
    assert.ok((await call('GET', `/api/order/intake/source/${M.sid}/shared?caps=delivery`)).body.writable.includes('product_mode'));
    out = await M.intranet(edited(await M.wo(), toOpt));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual((await M.opts()).map(x => [x.opt_key, x.unit_kind, x.status, Number(x.recruit_total), Number(x.pay_amount)]),
      [['블랙', 'option', 'active', 12, 13000], ['화이트', 'option', 'active', 8, 14000]]);
    w = await M.wo();
    assert.equal(JSON.parse(w.product_options_json)[0].product_mode, 'opt'); assert.equal(Number(w.recruit_count), 20);
    assert.equal(Number(w.pay_amount), 13000 * 12 + 14000 * 8);
    assert.equal(Number((await M.cRow()).recruit_total), 20);

    // M2 참여자가 있으면 거부 — 원래 상품 줄을 만든 것까지 통째로 되돌아간다(옵션 줄 0개 · 참여 기록 그대로)
    const M2 = await setup('m2');
    await M2.applyNone(2);
    const s2 = await M2.snap();
    out = await M2.intranet(edited(await M2.wo(), toOpt));
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'mode_in_use'); assert.match(out.body.error, /이미 참여한 분이 2명/);
    assert.equal(await M2.snap(), s2); assert.deepEqual(await M2.apps(), [{ option_key: null, n: 2 }]);

    // M3 옵션 있음 → 없음(참여 0): 옵션 줄 지우고 상품 줄 하나
    const M3 = await setup('m3', [JSON.parse(JSON.stringify(OPT_P)), JSON.parse(JSON.stringify(PROD_B))]);
    out = await M3.intranet(edited(await M3.wo(), p => { p[0].product_mode = 'none'; p[0].options = []; p[0].base = { pay: 17000, count: 17, daily: 3, review_type_mix: [] }; }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual((await M3.opts()).map(x => [x.opt_key, x.unit_kind, x.status, Number(x.recruit_total), Number(x.pay_amount)]),
      [['새상품', 'product', 'active', 5, 9000], ['탈취제', 'product', 'active', 17, 17000]]);
    assert.equal(Number((await M3.wo()).recruit_count), 22);

    // M4 옵션에 참여자가 있으면 옵션 있음 → 없음도 거부(아무것도 안 바뀜)
    const M4 = await setup('m4', [JSON.parse(JSON.stringify(OPT_P)), JSON.parse(JSON.stringify(PROD_B))]);
    await M4.applyKey('블랙', 1);
    const s4 = await M4.snap();
    out = await M4.intranet(edited(await M4.wo(), p => { p[0].product_mode = 'none'; p[0].options = []; p[0].base = { pay: 17000, count: 17, daily: 3, review_type_mix: [] }; }));
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'mode_in_use'); assert.equal(await M4.snap(), s4);
    // 다른 상품(참여 0)의 방식은 바꿀 수 있다
    out = await M4.intranet(edited(await M4.wo(), p => { p[1].product_mode = 'opt'; p[1].base = { ...p[1].base, pay: 0, count: 0, daily: 0 };
      p[1].options = [{ option_1: { name: '', value: '대' }, label: '대', url: '', pay: 9000, count: 5, daily: 1, review_type_mix: [] }]; }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok((await M4.opts()).some(x => x.opt_key === '대' && x.unit_kind === 'option'));

    // M5 방식을 모르는 옛 인트라넷 창 — 종전처럼 막힘(아무것도 안 바뀜)
    const M5 = await setup('m5');
    const s5 = await M5.snap();
    out = await M5.intranet(edited(await M5.wo(), toOpt), { mode: false });
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'field_not_editable'); assert.equal(await M5.snap(), s5);

    // M6 바꾼 뒤 모양 검사 — 옵션 있음인데 옵션 0개 · 옵션 없음인데 인원 0 은 거부
    out = await M5.intranet(edited(await M5.wo(), p => { p[0].product_mode = 'opt'; p[0].base = { ...p[0].base, count: 0, daily: 0 }; p[0].options = []; }));
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(await M5.snap(), s5);
    // ═══ ⑤-3 공고 창에서 옵션 있음↔없음 ═══
    const optRow = (pName, key, pay, rt, dl) => ({ optKey: key, prevOptKey: '', productName: pName, unitKind: 'option', optionUrl: '', payAmount: pay,
      recruitTotal: rt, dailyLimit: dl, status: 'active', inflowGuideHtml: '', inflowGuideImages: [] });
    // E1 옵션 없는 공고(줄 0개) → 원래 상품 이름의 옵션 줄 둘: 같은 상품의 방식 바꾸기(상품 주소·자리 유지)
    const E1 = await setup('e1');
    r = await put(E1.camp, b => { b.options = [optRow('단일상품', '블랙', 13000, 12, 2), optRow('단일상품', '화이트', 14000, 8, 2)]; b.recruit_total = 20; b.daily_limit = 4; });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.deepEqual((await E1.opts()).map(x => [x.opt_key, x.unit_kind, Number(x.recruit_total), Number(x.pay_amount)]), [['블랙', 'option', 12, 13000], ['화이트', 'option', 8, 14000]]);
    let pe = JSON.parse((await E1.wo()).product_options_json);
    assert.equal(pe.length, 1); assert.equal(pe[0].name, '단일상품'); assert.equal(pe[0].product_mode, 'opt'); assert.equal(pe[0].url, SINGLE[0].url, '상품 주소 유지');
    assert.deepEqual(pe[0].options.map(o => [o.label, o.count, o.pay]), [['블랙', 12, 13000], ['화이트', 8, 14000]]);

    // E2 옵션 있음 → 없음(공고 창) — 옵션 줄을 모두 빼고 같은 이름의 상품 줄
    const E2 = await setup('e2', [JSON.parse(JSON.stringify(OPT_P)), JSON.parse(JSON.stringify(PROD_B))]);
    r = await put(E2.camp, b => { b.options = b.options.filter(o => o.productName !== '탈취제');
      b.options.unshift(prodRow('탈취제', '', 17000, 17, 3)); b.recruit_total = 22; b.daily_limit = 4; });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    pe = JSON.parse((await E2.wo()).product_options_json);
    assert.deepEqual(pe.map(x => [x.name, x.product_mode, x.options.length, x.base.count, x.base.pay]), [['탈취제', 'none', 0, 17, 17000], ['새상품', 'none', 0, 5, 9000]]);
    assert.deepEqual((await E2.opts()).map(x => [x.opt_key, x.unit_kind]).sort(), [['새상품', 'product'], ['탈취제', 'product']]);

    // E3 참여자가 있으면 공고 창에서도 거부(아무것도 안 바뀜)
    const E3 = await setup('e3');
    await E3.applyNone(1);
    const s3 = await E3.snap();
    r = await put(E3.camp, b => { b.options = [optRow('단일상품', '블랙', 13000, 12, 2), optRow('단일상품', '화이트', 14000, 8, 2)]; b.recruit_total = 20; b.daily_limit = 4; });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'mode_in_use'); assert.equal(await E3.snap(), s3);
    // S11 바로 구매(표기가 다른 이름) — 상품을 더한 뒤에도 그 전 구매는 원래 상품 사용 수에 남는다 · 그 뒤 구매는 종전(이름으로만)
    const K = await setup('k');
    const direct = (n, label, ago) => pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, selected_product, submitted_at)
      SELECT $1, $1, $2, NOW() - ($3 || ' minutes')::interval FROM generate_series(1, $4)`, ['campaign:' + K.camp, label, String(ago), n]);
    await direct(3, '단일 1개 200ml 표기 다름', 60);
    out = await K.intranet(edited(await K.wo(), p => p.push(JSON.parse(JSON.stringify(PROD_B)))));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const { usedByOption } = require('../src/services/linkedRecruitQuota.service');
    let used = await usedByOption(pool, K.camp);
    assert.equal(used.get('단일상품') || 0, 3, '더하기 전 바로 구매 3건 = 원래 상품 몫: ' + JSON.stringify([...used]));
    assert.ok((await K.opts())[0].sole_until, '원래 상품 줄에 시각');
    await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, selected_product, submitted_at) VALUES ($1, $1, '또 다른 표기', NOW() + INTERVAL '1 minute')`, ['campaign:' + K.camp]);
    used = await usedByOption(pool, K.camp);
    assert.equal(used.get('단일상품') || 0, 3, '더한 뒤 표기 다른 구매는 종전대로 안 센다');
    // 원래 상품을 지우면 — 바로 구매가 있어 지우지 않고 마감(종전엔 세지 못해 지워질 수 있었다)
    out = await K.intranet(edited(await K.wo(), p => p.splice(0, 1)));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.closed_options, [{ pName: '단일상품', oLabel: '', used: 3 }]);
    // 옵션 있음으로 바꾸기도 바로 구매 3건 때문에 막힌다
    const K2 = await setup('k2');
    await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, selected_product, submitted_at) VALUES ($1, $1, '표기 다름', NOW() - INTERVAL '5 minutes')`, ['campaign:' + K2.camp]);
    out = await K2.intranet(edited(await K2.wo(), toOpt));
    assert.equal(out.status, 409, JSON.stringify(out.body)); assert.equal(out.body.code, 'mode_in_use');
    console.log('bidirPhase7SoleProduct: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    sw._resetBidirSwitchCacheForTest();
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query(`DELETE FROM order_submissions WHERE sheet_id = ANY($1)`, [camps.map(c => 'campaign:' + c)]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_soldout_reports WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_alerts WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_participants WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM campaign_fee_schedules WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_plan_events WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_price_history WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
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
  console.log('bidirPhase7SoleProduct: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
