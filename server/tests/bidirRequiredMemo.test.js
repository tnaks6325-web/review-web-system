/**
 * 결정 287 — 필수 배송메세지(결정 260)는 오더·공고 양방향 공유 칸.
 *   ① 순수 — 비교(연결 판정·대조·맞추기)에 들어간다 · 같은 정규화(공백 하나로·30자) · 공고 창 → 오더 계산 · 발행 프리필
 *   ② (PGTEST_URL) 진짜 PG + 실제 라우트:
 *      인트라넷이 바꾸면 → 공고 칸(구매양식 검사가 읽는 곳)
 *      공고 창에서 바꾸면 → 오더 · 인트라넷으로 보낼 거리 · 같은 값 다시 저장 = 공유 저장 없음
 *      연결 전 값이 다르면 "다름" — 맞추기에서 오더 쪽 / 공고 쪽 고르기
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');
const SP = require('../src/services/sharedPatch.service');
const { compareOrderCampaign, projectOrderToCampaign, readCampaignShared, SCALAR_KEYS } = require('../src/utils/orderToCampaignProjection');
const E = require('../src/utils/campaignSharedEdit');
const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');

const PRODUCTS = [{ name: '가짜 상품', url: 'https://www.coupang.com/vp/products/7', option_schema_version: 2, product_mode: 'none',
  base: { pay: 9000, count: 10, daily: 2, review_type_mix: [] }, options: [] }];

{
  assert.ok(SCALAR_KEYS.includes('required_delivery_memo'), '비교 칸');
  assert.ok(SP.PHASE3_SHARED_FIELDS.includes('required_delivery_memo'), '양방향 공유 칸(196)');
  assert.equal(_woCampaignPrefill({ required_delivery_memo: '  0 0  ' }).required_delivery_memo, '0 0', '발행 프리필 = 저장 규칙');
  assert.equal(projectOrderToCampaign({ required_delivery_memo: ' 00 ' }).required_delivery_memo, '00');
  assert.equal(readCampaignShared({ required_delivery_memo: '00' }).required_delivery_memo, '00');
  assert.deepEqual(compareOrderCampaign({ required_delivery_memo: '00' }, { required_delivery_memo: '00' }, [])
    .filter(d => d.field === 'required_delivery_memo'), [], '같으면 차이 없음');
  assert.deepEqual(compareOrderCampaign({ required_delivery_memo: '00' }, { required_delivery_memo: '' }, [])
    .filter(d => d.field === 'required_delivery_memo').map(d => d.kind), ['diff'], '오더에만 있으면 다름(연결 판정이 직원에게 묻는다)');
  assert.deepEqual(compareOrderCampaign({ required_delivery_memo: '' }, { required_delivery_memo: '22' }, [])
    .filter(d => d.field === 'required_delivery_memo').map(d => d.kind), ['diff'], '공고에만 있어도 다름 — 빈 값 = 확인 안 함(fill 로 접지 않는다)');
  assert.deepEqual(compareOrderCampaign({ required_delivery_memo: 'x'.repeat(40) }, { required_delivery_memo: 'x'.repeat(30) }, [])
    .filter(d => d.field === 'required_delivery_memo'), [], '30자 자르기도 같은 규칙');
  // 공고 창 → 오더
  const base = { required_delivery_memo: '00' };
  let p = E.planCampaignSharedEdit({ baseState: base, camp: {}, body: { required_delivery_memo: ' 11 ' } });
  assert.deepEqual(p.mine, { required_delivery_memo: '11' }); assert.deepEqual(p.unmappable, []);
  p = E.planCampaignSharedEdit({ baseState: base, camp: {}, body: { required_delivery_memo: '00' } });
  assert.deepEqual(p.mine, {}, '같은 값 = 바뀐 것 없음');
  p = E.planCampaignSharedEdit({ baseState: base, camp: {}, body: { title: '칸 없는 화면' } });
  assert.deepEqual(p.mine, {}, '칸을 안 보낸 화면 = 유지');
  p = E.planCampaignSharedEdit({ baseState: base, camp: {}, body: { required_delivery_memo: '' } });
  assert.deepEqual(p.mine, { required_delivery_memo: '' }, '비우기 = 확인 안 함으로');
  assert.deepEqual(E.driftFromCampaign({ required_delivery_memo: '00' }, { required_delivery_memo: '11' }), ['필수 배송메세지'], '옛 화면(기준 없음) = 거부');
}
console.log('bidirRequiredMemo: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const R = require('../src/services/sharedReconcile.service');
  const { linkSharedOrder, applySharedPatch, readSharedState } = SP;
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
  const sids = [], camps = [];
  /** 인트라넷 오더 + 공고(옵션 없음) — link=false 면 연결하지 않는다(맞추기 대상). */
  const setup = async (tag, { orderMemo = '', campMemo = '', link = true } = {}) => {
    const sid = `ro_rdm_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_rdm_${tag}_${stamp}`; camps.push(camp);
    const json = JSON.stringify(PRODUCTS);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 필수 배송메세지 ' + tag, recruit_count: 10, daily_count: 2, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/7',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      required_delivery_memo: orderMemo, product_options_json: json, product_option: productSummaryText(json), pay_amount: 90000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    assert.equal(w.required_delivery_memo, orderMemo, '접수가 오더 칸에 담는다');
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail,
         required_delivery_memo)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, $12, TRUE, 'active', $13::jsonb, $14)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product }),
        campMemo]);
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    if (link) {
      const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
      assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    }
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const intranet = async (patch) => {
      const cur = await wo();
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), ...patch }, baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷',
        conflictPolicy: 'last_writer', moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true });
    };
    return { sid, camp, w, wo, cRow, intranet };
  };
  const openBody = async (camp) => {
    const dd = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
    const c0 = dd.body.data;
    return { title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
      work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
      channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
      recruit_total: c0.recruit_total, daily_limit: c0.daily_limit, skip_weekends: c0.skip_weekends === true,
      required_delivery_memo: c0.required_delivery_memo,
      bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined };
  };
  const outbox = async (woId) => (await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1`, [woId])).rows[0].n;
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    await setSwitch('{"in2rw":"apply","push":"on","campaign_edit":"on"}');
    // ── 연결된 작업 ──
    const A = await setup('a');
    assert.equal((await A.cRow()).required_delivery_memo, '');
    // ① 인트라넷 → 공고 칸
    let r = await A.intranet({ required_delivery_memo: '00' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.campaign_applied || []).includes('required_memo'), JSON.stringify(r.body));
    assert.equal((await A.wo()).required_delivery_memo, '00'); assert.equal((await A.cRow()).required_delivery_memo, '00', '구매양식 검사가 읽는 공고 칸');
    // 지우기도 따라간다(빈 값 = 확인 안 함)
    r = await A.intranet({ required_delivery_memo: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal((await A.cRow()).required_delivery_memo, '');
    r = await A.intranet({ required_delivery_memo: '00' });
    assert.equal((await A.cRow()).required_delivery_memo, '00');

    // ② 공고 창 → 오더 · 인트라넷으로 보낼 거리
    const ob0 = await outbox(A.w.id);
    let eb = await openBody(A.camp);
    assert.equal(eb.required_delivery_memo, '00', '창은 공고 값으로 열린다');
    eb.required_delivery_memo = ' 11 ';
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.ok(r.body.shared && r.body.shared.changed.includes('필수 배송메세지'), JSON.stringify(r.body.shared));
    assert.equal((await A.wo()).required_delivery_memo, '11', '오더도 바뀐다');
    assert.equal((await A.cRow()).required_delivery_memo, '11', '공고 칸 = 오더 값');
    assert.equal(r.body.requiredMemoWarning, undefined);
    assert.ok(await outbox(A.w.id) > ob0, '인트라넷으로 보낼 거리');
    // 같은 값 다시 저장 = 공유 저장 없음
    eb = await openBody(A.camp);
    const v1 = Number((await A.wo()).sync_version);
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.shared, undefined, '그대로 = 공유 저장 없음');
    assert.equal(Number((await A.wo()).sync_version), v1);
    // 칸이 없는 화면(미전송) = 공고·오더 그대로
    eb = await openBody(A.camp); delete eb.required_delivery_memo; eb.title = '제목만';
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, eb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await A.cRow()).required_delivery_memo, '11'); assert.equal((await A.wo()).required_delivery_memo, '11');

    // ── 연결 전 값이 다른 작업 = 맞추기 ──
    const B = await setup('b', { orderMemo: '00', campMemo: '', link: false });
    let ln = await linkSharedOrder({ workOrderId: B.w.id, actor: '시험' });
    assert.notEqual(ln.body.state, 'on', '값이 다르면 자동 연결하지 않는다: ' + JSON.stringify(ln.body));
    const item = async (wo) => (await R.listReconcile(pool)).items.find(x => x.workOrderId === wo);
    let it = await item(B.w.id);
    assert.ok(it, '맞추기 목록에 나온다');
    const f = it.fields.find(x => x.id === 'required_delivery_memo');
    assert.ok(f && f.label === '필수 배송메세지' && f.orderText === '00' && f.campaignText === '(비어 있음)', JSON.stringify(it.fields));
    r = await R.reconcileSharedOrder({ workOrderId: B.w.id, picks: { required_delivery_memo: 'order' }, fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await B.cRow()).required_delivery_memo, '00', '오더 쪽으로 = 공고 칸이 오더 값'); assert.equal((await B.wo()).bidir_state, 'on');

    const C = await setup('c', { orderMemo: '', campMemo: '22', link: false });
    ln = await linkSharedOrder({ workOrderId: C.w.id, actor: '시험' });
    assert.notEqual(ln.body.state, 'on', '공고에만 값이 있어도 자동 연결하지 않는다: ' + JSON.stringify(ln.body));
    it = await item(C.w.id);
    assert.ok(it && it.fields.some(x => x.id === 'required_delivery_memo'), '맞추기 목록에 나온다');
    r = await R.reconcileSharedOrder({ workOrderId: C.w.id, picks: { required_delivery_memo: 'campaign' }, fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await C.wo()).required_delivery_memo, '22', '공고 쪽으로 = 오더가 공고 값'); assert.equal((await C.cRow()).required_delivery_memo, '22');
    assert.equal((await C.wo()).bidir_state, 'on');
    console.log('bidirRequiredMemo: pg passed');
  } finally {
    if (prevSetting) await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'bidir_sync'`, [prevSetting.value]);
    else await pool.query(`DELETE FROM app_settings WHERE key = 'bidir_sync'`);
    for (const c of camps) await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [c]);
    for (const s of sids) {
      const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = $1', [s])).rows.map(x => x.id);
      for (const id of ids) {
        for (const t of ['shared_sync_outbox', 'work_order_shared_snapshots']) await pool.query(`DELETE FROM ${t} WHERE work_order_id = $1`, [id]).catch(() => {});
        await pool.query('DELETE FROM work_orders WHERE id = $1', [id]);
      }
    }
    srv.close();
    await pool.end().catch(() => {});
  }
}

if (process.env.PGTEST_URL) pg().catch(e => { console.error(e); process.exit(1); });
