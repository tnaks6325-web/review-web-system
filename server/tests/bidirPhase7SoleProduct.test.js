/**
 * 양방향 7단계-④ ⑤-2 옵션 없이 상품 하나로 도는 공고(공고 옵션 줄 0개) 열기(결정 263 · 사용자 확정 2026-10-21 「2.가」).
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
const PROD_B = { name: '새상품', url: 'https://smartstore.naver.com/x/products/2', option_schema_version: 2, product_mode: 'none',
  base: { pay: 9000, count: 5, daily: 1, review_type_mix: [] }, options: [] };

{
  // 정적 — 열림 판정 단일 출처(상품 하나짜리면 옵션 줄 0개여도 연다)
  const src = require('fs').readFileSync(require.resolve('../src/services/sharedPatch.service'), 'utf8');
  assert.match(src, /return rows\.length > 0 \|\| !!_soleProductUnit\(st\);/);
  assert.ok(src.indexOf('adopted = await _adoptSoleProductInTx(client, camp, theirs);') < src.indexOf('closure = await _closeRemovedInTx(client, camp, theirs, next, structure);'),
    '원래 상품 줄을 먼저 만든다(마감 판정이 그 줄의 참여 수를 읽는다)');
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
    // 옵션 줄 없음 — 운영의 옵션 없는 공고(16개 중 7개)와 같은 모양
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
    const intranet = async (patch) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: true, renameCapable: true,
        reviewTypeCapable: true, deliveryCapable: true });
    };
    return { sid, camp, tab, w, wo, cRow, opts, apps, rows, applyNone, intranet };
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
