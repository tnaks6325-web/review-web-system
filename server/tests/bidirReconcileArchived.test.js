/**
 * 결정 312 — 마감(보관)된 공고로 「오더·공고 맞추기」(사용자 확정 2026-10-30 「진행해」 · 쟈니베어 군인핫팩 오더 500·하루 50 / 공고 200·하루 15).
 *   ① 기본 목록·담당자 팝업에는 안 나온다 — ?archived=1 묶음에만 ② 오더 쪽은 못 고른다(공고는 바꾸지 않는다)
 *   ③ 맞추면 오더가 공고 값이 되고 연결·인트라넷 송신 대기열에 오른다 · **보관 공고·옵션은 한 글자도 안 바뀐다**
 *   ④ 살아 있는 공고가 있으면 거절(그건 보통 맞추기) ⑤ 깃발 없이 보내면 종전대로 no_campaign.
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const fs = require('fs');
const { productSummaryText } = require('../src/utils/orderProductSummary');

const OPT_P = [{ name: '탈취제', url: 'https://smartstore.naver.com/x/products/11', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
  { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
  { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] }];

const staticDone = (async () => {
  // 정적 — 보관 공고는 읽기만(완화 금지)
  const sp = fs.readFileSync(require.resolve('../src/services/sharedPatch.service'), 'utf8');
  const sr = fs.readFileSync(require.resolve('../src/services/sharedReconcile.service'), 'utf8');
  assert.match(sp, /if \(camp && !recArchived && \(plan\.writes\.length \|\| rec\)\)/, '보관 공고에는 공고 반영을 하지 않는다');
  assert.match(sp, /code: 'archived_campaign_side_only'/, '오더 쪽 고르기 거절');
  assert.match(sp, /code: 'campaign_live'/, '살아 있는 공고가 있으면 거절');
  assert.match(sp, /archivedCampaignSql\('\$1', true\)/, '저장도 목록과 같은 공고 고르기 SQL');
  assert.match(sr, /JOIN LATERAL \(\$\{archivedCampaignSql\('w0\.id', false\)\}\) c ON TRUE/, '목록도 같은 SQL');
  assert.match(sr, /if \(archived\) return _listArchivedReconcile\(db\);/);
  const pr = fs.readFileSync(require.resolve('../../frontend/js/reconcile-prompt.js'), 'utf8');
  assert.ok(!/archived=1/.test(pr), '담당자 팝업은 마감 묶음을 부르지 않는다');
  const wd = fs.readFileSync(require.resolve('../../frontend/workdesk.html'), 'utf8');
  assert.match(wd, /api\('\/api\/trackb\/bidir\/reconcile'\+\(arch\?'\?archived=1':''\)\)/, '화면은 묶음에 따라 부른다');
  assert.match(wd, /if\(arch!==!!st\.arch\) return;/, '늦게 온 옛 묶음 응답으로 덮지 않는다');
  // Codex P1(배포 스큐) — 새 화면 + 옛 서버: 서버가 마감 묶음이라고 답하지 않으면 아무것도 안 보여 준다 · 항목도 마감 표시만
  assert.match(wd, /if\(arch && r\.archived!==true\)\{ st\.items=null;/);
  assert.match(wd, /if\(arch\) r\.items=\(r\.items\|\|\[\]\)\.filter\(x=>x&&x\.archived===true\);/);
  assert.match(sr, /return \{ items, counts: \{ diverged: items\.length \}, archived: true \};/, '서버는 마감 묶음임을 답한다');
  {
    // vm — _rcLoad 를 옛 서버 응답(마감 표시 없음)과 새 서버 응답으로 실제 실행
    const vm = require('vm');
    const start = wd.indexOf('async function _rcLoad(){'); const end = wd.indexOf('\nfunction _rcMgr(', start);
    const run = async (resp) => {
      const ctx = { STATE: { woRecon: false, rc: { items: null, picks: {}, arch: true } }, api: async () => resp, $: () => null, _rcRender() {} };
      ctx._rcState = () => ctx.STATE.rc;
      vm.createContext(ctx); vm.runInContext(wd.slice(start, end) + '; this.f = _rcLoad;', ctx);
      await ctx.f(); return ctx.STATE.rc;
    };
    const live = { workOrderId: 'w1', fingerprint: 'a', fields: [] };
    const old = await run({ ok: true, items: [live], counts: { diverged: 1 } });
    assert.equal(old.items, null, '옛 서버 응답 = 목록 없음'); assert.match(old.loadError, /새 버전이 아닙니다/);
    const neu = await run({ ok: true, archived: true, items: [{ ...live, workOrderId: 'w2', archived: true }, live] });
    assert.deepEqual(neu.items.map(x => x.workOrderId), ['w2'], '마감 표시 없는 항목은 버린다');
  }
  assert.equal((wd.match(/\.\.\.\(it\.archived\?\{ archived:true \}:\{\}\)/g) || []).length, 2, '미리보기·맞추기 둘 다 깃발을 싣는다');
  assert.match(wd, /if\(it\.archived\) return '';   \/\/ 결정 312/, '마감 묶음엔 따로 두기 없음');
  console.log('bidirReconcileArchived: static passed');
})();

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder } = require('../src/services/sharedPatch.service');
  const R = require('../src/services/sharedReconcile.service');
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const jwt = require('jsonwebtoken');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const { rows: prevRows } = await pool.query(`SELECT value FROM app_settings WHERE key='bidir_sync'`);
  const prevSetting = prevRows[0];
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', '{"in2rw":"apply","campaign_edit":"on"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  sw._resetBidirSwitchCacheForTest();
  const sids = [], camps = [], tabs = [];
  const SHEET = 'sheet_rca';
  /** 인트라넷 오더 + 발행 그대로의 공고(옵션 줄) → diverge(공고만 고침) → 연결 시도(diverged). */
  const setup = async (tag, diverge) => {
    const sid = `ro_rca_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_rca_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_rca_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(OPT_P);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 맞추기 ' + tag, recruit_count: 17, daily_count: 3, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: OPT_P[0].url,
      inflow_type: 'link', purchase_channel: '스마트스토어', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 15900 * 5 + 21500 * 12 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    await pool.query(`UPDATE work_orders SET work_manager = '박은비' WHERE id = $1`, [w.id]);
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
    let i = 0;
    for (const o of proj.options) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0, i++]);
    }
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, delivery_type, taekhap, updated_at) VALUES ($1, $2, $3, TRUE, '실배송', FALSE, NOW())`, [SHEET, tab, 'g' + tag + stamp]);
    for (let k = 1; k <= 17; k++) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, option_text, source, updated_by, updated_at)
                        VALUES ($1, $2, $3, '{}'::jsonb, $4, 'worktable', '시험', NOW())`, [SHEET, tab, k, k <= 5 ? '블랙' : '화이트']);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    if (diverge) await diverge(camp);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query(`SELECT * FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'deleted' ORDER BY sort_order, id`, [camp])).rows;
    const item = async () => (await R.listReconcile(pool)).items.find(x => x.workOrderId === w.id);
    return { sid, camp, tab, w, ln, wo, cRow, opts, item };
  };
  const admin = { authorization: 'Bearer ' + jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET) };
  const outboxRows = async (id) => (await pool.query('SELECT sync_version, view_scope FROM shared_sync_outbox WHERE work_order_id = $1', [id])).rows;
  const campSnap = async (camp) => JSON.stringify({
    c: (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0],
    o: (await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id', [camp])).rows });
  // 쟈니베어 모양 — 공고(리뷰어 화면)에서 인원·일건수를 줄인 뒤 마감(보관) · 오더는 옛 값
  const shrink = async (camp) => {
    await pool.query(`UPDATE campaign_options SET recruit_total = 8, daily_limit = 1 WHERE campaign_id = $1 AND opt_key = '화이트'`, [camp]);
    await pool.query(`UPDATE recruit_campaigns SET recruit_total = 13, daily_limit = 2 WHERE id = $1`, [camp]);
  };
  try {
    const A = await setup('a', shrink);
    assert.equal(A.ln.body.state, 'diverged', JSON.stringify(A.ln.body));
    await pool.query(`UPDATE recruit_campaigns SET archived_at = NOW(), status = 'draft' WHERE id = $1`, [A.camp]);
    // ① 기본 목록(담당자 팝업이 보는 것)에는 없다 · 마감 묶음에만
    assert.ok(!(await R.listReconcile(pool)).items.find(x => x.workOrderId === A.w.id), '기본 목록에 안 나온다');
    let h = await call('GET', '/api/trackb/bidir/reconcile?archived=1', null, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const it = h.body.items.find(x => x.workOrderId === A.w.id);
    assert.ok(it, '마감 묶음에 나온다'); assert.equal(it.archived, true); assert.equal(it.campaignId, A.camp); assert.equal(it.blocked, null);
    const pickable = it.fields.filter(f => !f.derived);
    assert.ok(pickable.length >= 2, JSON.stringify(it.fields.map(f => f.id)));
    assert.ok(pickable.every(f => f.orderSide && f.orderSide.ok === false && f.campaignSide.ok === true), '오더 쪽은 막고 공고 쪽만');
    const allCamp = Object.fromEntries(pickable.map(f => [f.id, 'campaign']));
    const before = await campSnap(A.camp);
    const wo0 = await A.wo();
    // ⑤ 깃발 없이 = 종전대로(보관 공고는 맞추기 대상 아님)
    h = await call('POST', `/api/trackb/bidir/reconcile/${A.w.id}`, { picks: allCamp, fingerprint: it.fingerprint, dryRun: true }, admin);
    assert.equal(h.status, 409); assert.equal(h.body.code, 'no_campaign');
    // ② 오더 쪽 하나라도 = 거절
    const oneOrder = { ...allCamp, [pickable[0].id]: 'order' };
    h = await call('POST', `/api/trackb/bidir/reconcile/${A.w.id}`, { picks: oneOrder, fingerprint: it.fingerprint, dryRun: true, archived: true }, admin);
    assert.equal(h.status, 409, JSON.stringify(h.body)); assert.equal(h.body.code, 'archived_campaign_side_only');
    // 미리보기 = 아무것도 안 바뀐다
    h = await call('POST', `/api/trackb/bidir/reconcile/${A.w.id}`, { picks: allCamp, fingerprint: it.fingerprint, dryRun: true, archived: true }, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body)); assert.equal(h.body.dryRun, true);
    assert.equal((await A.wo()).sync_version, wo0.sync_version, '미리보기는 되돌린다');
    // ③ 맞추기
    h = await call('POST', `/api/trackb/bidir/reconcile/${A.w.id}`, { picks: allCamp, fingerprint: it.fingerprint, archived: true, opId: 'rca-' + stamp }, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const wo1 = await A.wo();
    assert.equal(wo1.bidir_state, 'on');
    assert.equal(Number(wo1.recruit_count), 13); assert.equal(Number(wo1.daily_count), 2);
    const w = JSON.parse(wo1.product_options_json)[0].options.find(o => o.label === '화이트');
    assert.equal(Number(w.count), 8); assert.equal(Number(w.daily), 1);
    assert.equal(Number(wo1.pay_amount), 15900 * 5 + 21500 * 8, '상품구입비 다시 계산');
    assert.match(String(wo1.product_option), /8명/, '요약 문구 다시 만듦');
    assert.equal(await campSnap(A.camp), before, '보관 공고·옵션은 한 글자도 안 바뀐다');
    const ob = await outboxRows(A.w.id);
    assert.ok(ob.some(r => Number(r.sync_version) === Number(wo1.sync_version) && r.view_scope === 'full'), '인트라넷 송신 대기열(전체)');
    assert.equal((await R.listReconcile(pool, { archived: true })).items.find(x => x.workOrderId === A.w.id), undefined, '맞춘 뒤 목록에서 빠진다');
    // 같은 맞추기 재전송 = 멱등
    h = await call('POST', `/api/trackb/bidir/reconcile/${A.w.id}`, { picks: allCamp, fingerprint: it.fingerprint, archived: true, opId: 'rca-' + stamp }, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body)); assert.equal(h.body.idempotent, true);
    // ③-2 보관 공고의 합계 칸이 옵션 합과 어긋난 경우 — 보통 맞추기라면 공고 합계를 옵션 합으로 다시 쓰는 자리다.
    //   마감 묶음은 공고를 쓰지 않으므로: 맞추면(200) 공고는 그대로 · 못 맞추면(409) 아무것도 안 바뀐다. 어느 쪽이든 공고 무변화.
    const C = await setup('c', async (camp) => { await shrink(camp); await pool.query(`UPDATE recruit_campaigns SET recruit_total = 20, daily_limit = 9 WHERE id = $1`, [camp]); });
    await pool.query(`UPDATE recruit_campaigns SET archived_at = NOW(), status = 'draft' WHERE id = $1`, [C.camp]);
    const ci = (await R.listReconcile(pool, { archived: true })).items.find(x => x.workOrderId === C.w.id);
    assert.ok(ci, JSON.stringify(ci));
    const cBefore = await campSnap(C.camp); const cWo0 = await C.wo();
    h = await call('POST', `/api/trackb/bidir/reconcile/${C.w.id}`, { picks: Object.fromEntries(ci.fields.filter(f => !f.derived).map(f => [f.id, 'campaign'])), fingerprint: ci.fingerprint, archived: true }, admin);
    assert.ok(h.status === 200 || h.body.code === 'reconcile_incomplete' || h.body.code === 'reconcile_blocked', JSON.stringify(h.body));
    assert.equal(await campSnap(C.camp), cBefore, '어긋난 합계여도 보관 공고는 그대로');
    if (h.status !== 200) assert.equal((await C.wo()).sync_version, cWo0.sync_version, '못 맞추면 오더도 그대로');
    console.log('bidirReconcileArchived: C =', h.status, h.body.code || 'ok');
    // ④ 살아 있는 공고가 있으면 마감 묶음에 없고, 깃발로 보내도 거절
    const B = await setup('b', shrink);
    await pool.query(`UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1`, [B.camp]);
    const live = 'camp_rca_live_' + stamp; camps.push(live);
    await pool.query(`INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, status, participation_mode) VALUES ($1, '가짜 새 공고', $2, 17, 'active', TRUE)`, [live, B.w.id]);
    assert.equal((await R.listReconcile(pool, { archived: true })).items.find(x => x.workOrderId === B.w.id), undefined, '살아 있는 공고가 있으면 마감 묶음에 없다');
    const bp = R.planReconcile(await B.wo(), (await pool.query('SELECT * FROM recruit_campaigns WHERE id=$1', [B.camp])).rows[0], (await pool.query('SELECT * FROM campaign_options WHERE campaign_id=$1 ORDER BY sort_order, id', [B.camp])).rows);
    h = await call('POST', `/api/trackb/bidir/reconcile/${B.w.id}`, { picks: Object.fromEntries(bp.fields.filter(f => !f.derived).map(f => [f.id, 'campaign'])), fingerprint: bp.fingerprint, archived: true }, admin);
    assert.equal(h.status, 409, JSON.stringify(h.body)); assert.equal(h.body.code, 'campaign_live');
    assert.notEqual((await B.wo()).bidir_state, 'on');
    console.log('bidirReconcileArchived: PG passed');
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
    await pool.query('DELETE FROM campaign_option_price_history WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_alerts WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1)', [ids]).catch(() => {});
  }
}

(async () => {
  await staticDone;
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirReconcileArchived: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
