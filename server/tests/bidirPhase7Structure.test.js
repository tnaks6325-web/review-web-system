/**
 * 양방향 7단계-④ 구조 — ① 새는 틈 막기(결정 263 · 사용자 확정 2026-10-21 「1.가 2.가 3.가 4.가」).
 *   연결 공고(연결 오더가 있으면 스위치와 상관없이)의 구조 변경은 공고만 바뀌고 오더·인트라넷에는 안 갔다(조용한 갈라짐).
 *   ① 판정(`structureChangesFromCampaign`) — 옵션 더하기·지우기·이름·마감, 상품 이름·방식, 배송 방식, 리뷰타입 종류, 체험단 종류.
 *      접수 뒤 영구 금지(체험단 종류·배송 혼합·회수) = permanent. 수량(인원·혼합 수량)은 7단계-② 몫이라 보지 않는다.
 *   ② (PGTEST_URL) 실제 라우트: 공고 창 409 쓰기 0 · 스위치 꺼져도 409 · 같은 값 저장은 통과 · 리뷰어앱 배송 방식 409 ·
 *      옵션 합치기 409 · 연결 안 된 공고는 종전대로 저장.
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

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder } = require('../src/services/sharedPatch.service');
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
  const sids = [], camps = [];
  /** 인트라넷 오더 + 발행 그대로인 공고(옵션 줄 포함) + 연결(link=false 면 연결하지 않는다). */
  const setup = async (tag, { link = true } = {}) => {
    const sid = `ro_p7s_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_p7s_${tag}_${stamp}`; camps.push(camp);
    const json = JSON.stringify(OPT_PRODUCTS);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 구조 ' + tag, recruit_count: 20, daily_count: 4, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/7',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 15900 * 5 + 21500 * 12 + 9000 * 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', FALSE, $8, '', $9, $10, $11, TRUE, 'active', $12::jsonb)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product })]);
    for (const o of proj.options) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    if (link) {
      await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
      const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
      assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    }
    const snap = async () => {
      const c = (await pool.query('SELECT delivery_type, review_type, work_kind, delivery_type_mix FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
      const o = (await pool.query('SELECT opt_key, product_name, unit_kind, status FROM campaign_options WHERE campaign_id = $1 ORDER BY opt_key', [camp])).rows;
      const wo = (await pool.query('SELECT sync_version, product_options_json, delivery_type FROM work_orders WHERE id = $1', [w.id])).rows[0];
      return JSON.stringify([c, o, wo]);
    };
    return { camp, w, snap };
  };
  const openBody = async (camp) => {
    const dd = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
    const c0 = dd.body.data;
    return { title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
      work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
      channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
      recruit_total: c0.recruit_total, daily_limit: c0.daily_limit, delivery_type: c0.delivery_type, review_type: c0.review_type, work_kind: c0.work_kind || 'review',
      options: (dd.body.options || []).map(x => ({ optKey: x.optKey, prevOptKey: x.optKey, productName: x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
        recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
      fee_schedules: (dd.body.feeSchedules || []).map(x => ({ effectiveFrom: x.effectiveFrom, reviewFee: x.reviewFee, memo: x.memo })),
      bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined };
  };
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    const A = await setup('a');
    const s0 = await A.snap();
    const put = async (fn) => { const b = await openBody(A.camp); fn(b); return call('PUT', `/api/campaign/admin/${A.camp}`, b, admin); };

    // 같은 값 저장 = 통과(구조 그대로)
    let r = await put(() => {});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.equal(await A.snap(), s0);

    const blocked = async (label, fn, code, field) => {
      const res = await put(fn);
      assert.equal(res.status, 409, label + ': ' + JSON.stringify(res.body));
      assert.equal(res.body.code, code, label + ': ' + JSON.stringify(res.body));
      if (field) assert.ok(res.body.fields.includes(field), label + ': ' + JSON.stringify(res.body));
      assert.equal(await A.snap(), s0, label + ' — 쓰기 0');
    };
    await blocked('옵션 더하기', b => b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '' }), 'structure_linked_pending', '옵션·상품 추가');
    await blocked('옵션 지우기', b => { b.options = b.options.filter(o => o.optKey !== '블랙'); }, 'structure_linked_pending', '옵션·상품 삭제');
    await blocked('옵션 이름', b => { b.options[0].optKey += '2'; }, 'structure_linked_pending', '옵션·상품 이름');
    await blocked('옵션 마감', b => { b.options[0].status = 'closed'; }, 'structure_linked_pending', '옵션 마감·다시 열기');
    await blocked('배송 한 종류끼리', b => { b.delivery_type = '빈박스'; }, 'structure_linked_pending', '배송 방식');
    await blocked('리뷰타입', b => { b.review_type = '텍스트'; }, 'structure_linked_pending', '리뷰타입');
    await blocked('배송 혼합', b => { b.delivery_type = '혼합'; b.delivery_type_mix = [{ type: 'real', quantity: 10 }, { type: 'empty', quantity: 10 }];
      b.delivery_review_fee_mix = [{ type: 'real', reviewFee: 1000 }, { type: 'empty', reviewFee: 1000 }]; }, 'structure_new_order', '배송 방식');
    await blocked('체험단 종류', b => { b.work_kind = 'blog'; }, 'structure_new_order', '체험단 종류');
    r = await put(b => { b.work_kind = 'blog'; b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '' }); });
    assert.ok(/새 리뷰오더/.test(r.body.error), '영구 금지가 섞이면 새 오더 안내가 먼저: ' + JSON.stringify(r.body));

    // 스위치가 꺼져 있어도 구조는 막힌다(연결 오더가 있으면)
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    await blocked('스위치 꺼짐 + 옵션 더하기', b => b.options.push({ ...b.options[0], optKey: '그레이', prevOptKey: '' }), 'structure_linked_pending');
    // 리뷰어앱 공고 수정 — 배송 방식(같은 값은 통과)
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { delivery_type: '빈박스' }, scoped);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'shared_field_scoped'); assert.deepEqual(r.body.fields, ['배송 방식']);
    assert.equal(await A.snap(), s0);
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { delivery_type: '실배송', title: '같은 배송 + 제목' }, scoped);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
    r = await call('PUT', `/api/campaign/admin/${A.camp}`, { delivery_type: '빈박스' }, scoped);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.deepEqual(r.body.fields, ['배송 방식'], '스위치가 켜져 있어도');
    // 옵션 합치기
    await pool.query(`UPDATE campaign_options SET status = 'closed' WHERE campaign_id = $1 AND opt_key = '블랙'`, [A.camp]);
    r = await call('POST', `/api/campaign/admin/${A.camp}/options/merge`, { pairs: [{ from: '블랙', to: '화이트' }], confirm: true }, admin);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'structure_linked_pending');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM campaign_options WHERE campaign_id = $1 AND opt_key = '블랙'`, [A.camp])).rows[0].n, 1, '합치기 쓰기 0');
    await pool.query(`UPDATE campaign_options SET status = 'active' WHERE campaign_id = $1 AND opt_key = '블랙'`, [A.camp]);

    // 연결 안 된 공고 = 종전대로(옵션 더하기 저장됨)
    const N = await setup('n', { link: false });
    const nb = await openBody(N.camp);
    nb.options.push({ ...nb.options[0], optKey: '그레이', prevOptKey: '' });
    r = await call('PUT', `/api/campaign/admin/${N.camp}`, nb, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.equal((await pool.query(`SELECT count(*)::int n FROM campaign_options WHERE campaign_id = $1 AND opt_key = '그레이'`, [N.camp])).rows[0].n, 1);
    console.log('bidirPhase7Structure: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    sw._resetBidirSwitchCacheForTest();
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
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
