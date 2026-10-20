/**
 * 양방향 6단계(결정 263 · 사용자 확정 2026-10-20 「1번」 — 지금 화면 모양 {글, 사진은 글 아래}로 맞춤) — 선택지별 유입가이드.
 *   ① 비교 규칙: 서버 투영(글만 + 사진 목록)과 공고 창 저장(글 + 끝에 <img> + 사진 목록)은 같은 가이드
 *   ② 연결 저장이 옵션·상품 guide 칸을 연다 · 적용(지움 포함)
 *   ③ 공고 창 가이드 → 오더 guide(옵션 · "옵션 없음" 라벨은 상품 · 링크유입은 공고 전용) · 왕복 검사
 *   ④ (PGTEST_URL) 진짜 PG: 인트라넷 가이드 수정 → 바뀐 줄만 공고 · 옛 인트라넷(guide 표시 없음)·링크유입 저장은 가이드 안 건드림 ·
 *      가이드유입인데 빈 가이드 = 409 쓰기 0 · 공고 창 가이드 → 오더 · 창을 연 뒤 바뀐 가이드 안 되돌림
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const G = require('../src/utils/guideCanon');
const compose = require('../src/utils/inflowGuideCompose');
const SP = require('../src/services/sharedPatch.service');
const { planSharedPatch } = require('../src/utils/sharedPatchPlan');
const E = require('../src/utils/campaignSharedEdit');

const IMG = n => `https://x.up.railway.app/api/order/guide-image/FAKEguideImageId0000000${n}`;
const PRODUCTS = [{ name: '가이드 상품', url: 'https://www.coupang.com/vp/products/6', option_schema_version: 2, product_mode: 'opt',
  base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: 'https://www.coupang.com/vp/products/6', pay: 10000, count: 5, daily: 1, review_type_mix: [], guide: { text: '검색창에 "블랙 탈취제"\n두 번째 줄', images: [IMG(1)] } },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: 'https://www.coupang.com/vp/products/6', pay: 10000, count: 5, daily: 1, review_type_mix: [], guide: { text: '화이트 가이드', images: [IMG(2)] } }] }];

// ── ① 비교 규칙 ──
{
  const a = compose.composeUnitGuide(PRODUCTS[0].options[0]);
  const editor = '검색창에 &quot;블랙 탈취제&quot;<br>두 번째 줄<img src="' + IMG(1) + '">';
  assert.equal(G.canonGuideKey(a.html, a.images), G.canonGuideKey(editor, [IMG(1)]), '투영 모양 = 공고 창 모양');
  assert.notEqual(G.canonGuideKey(a.html, a.images), G.canonGuideKey(editor.replace('두 번째', '세 번째'), [IMG(1)]));
  assert.notEqual(G.canonGuideKey(a.html, a.images), G.canonGuideKey(editor, [IMG(1), IMG(3)]), '사진이 늘면 다름');
  assert.equal(G.canonGuideKey(a.html, a.images), G.canonGuideKey(a.html, [IMG(1).replace('https://x.up', 'http://y.up')]), '같은 파일(주소만 다름) = 같음');
  assert.equal(G.canonGuideKey('', []), '');
}

// ── ② 쓸 수 있는 경로 · 적용 ──
{
  const base = { product_options_json: JSON.stringify(PRODUCTS), inflow_type: 'guide' };
  const edit = fn => { const p = JSON.parse(JSON.stringify(PRODUCTS)); fn(p); return { ...base, product_options_json: JSON.stringify(p) }; };
  const mine = edit(p => { p[0].options[0].guide = { text: '바뀐 블랙 가이드', images: [] }; delete p[0].options[1].guide; });
  const pl = planSharedPatch({ base, mine, theirs: base, origin: 'intranet' });
  assert.ok([...pl.writes, ...pl.conflicts].every(w => SP.writablePath(w, 'intranet')), '가이드 칸 = 연다');
  const aw = SP.applyWrites(base, mine, pl.writes);
  const j = JSON.parse(aw.next.product_options_json);
  assert.deepEqual(j[0].options[0].guide, { text: '바뀐 블랙 가이드', images: [] });
  assert.equal(j[0].options[1].guide, undefined, '지움도 적용');
  assert.equal(aw.guideTouched, true); assert.equal(aw.payTouched, false); assert.deepEqual(aw.missed, []);
}

// ── ③ 공고 창 가이드 → 오더 ──
{
  const base = { product_options_json: JSON.stringify(PRODUCTS), inflow_type: 'guide' };
  const campOptions = [{ opt_key: '블랙', product_name: '가이드 상품', unit_kind: 'option', pay_amount: 10000 }, { opt_key: '화이트', product_name: '가이드 상품', unit_kind: 'option', pay_amount: 10000 }];
  const opt = (k, html, imgs) => ({ optKey: k, productName: '가이드 상품', unitKind: 'option', payAmount: 10000, inflowGuideHtml: html, inflowGuideImages: imgs });
  const asIs = k => { const g = compose.composeUnitGuide(PRODUCTS[0].options[k === '블랙' ? 0 : 1]); return opt(k, g.html, g.images); };
  // 공고 창이 저장하는 모양(글 + 끝 <img>)으로 다시 보내도 = 손대지 않음
  const editorFmt = opt('블랙', '검색창에 &quot;블랙 탈취제&quot;<br>두 번째 줄<img src="' + IMG(1) + '">', [IMG(1)]);
  let p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: [editorFmt, asIs('화이트')], work_detail: { inflowType: 'guide' } }, campOptions });
  assert.deepEqual(p.mine, {}); assert.deepEqual(p.unmappable, []);
  p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: [asIs('블랙'), opt('화이트', '화이트 새 가이드<br>둘째 줄<img src="' + IMG(3) + '">', [IMG(3)])], work_detail: { inflowType: 'guide' } }, campOptions });
  assert.deepEqual(p.unmappable, []); assert.deepEqual(p.changed, ['유입가이드(가이드 상품 / 화이트)']);
  const j = JSON.parse(p.mine.product_options_json);
  assert.deepEqual(j[0].options[1].guide, { text: '화이트 새 가이드\n둘째 줄', images: [IMG(3)] });
  assert.deepEqual(j[0].options[0].guide, PRODUCTS[0].options[0].guide, '안 바꾼 줄 그대로');
  // 링크유입 공고 = 공고 전용(오더로 안 보냄)
  p = E.planCampaignMoneyEdit({ baseState: { ...base, inflow_type: 'link' }, camp: {}, body: { options: [asIs('블랙'), opt('화이트', '다름', [])], work_detail: { inflowType: 'link' } }, campOptions });
  assert.deepEqual(p.mine, {});
  // 비우기 = 빈 가이드(칸은 남김 — 인트라넷 수신이 "안 실었다" 로 읽지 않게)
  p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: [asIs('블랙'), opt('화이트', '', [])], work_detail: { inflowType: 'guide' } }, campOptions });
  assert.deepEqual(JSON.parse(p.mine.product_options_json)[0].options[1].guide, { text: '', images: [] });
  // 창이 불러온 지금 공고 값 그대로 = 손대지 않음(공고에서만 고쳐 둔 옛 가이드를 오더로 끌어오지 않는다)
  const campOnly = [{ ...campOptions[0], inflow_guide_html: '공고에서만 고친 블랙', inflow_guide_images: [] }, campOptions[1]];
  p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: [opt('블랙', '공고에서만 고친 블랙', []), asIs('화이트')], work_detail: { inflowType: 'guide' } }, campOptions: campOnly });
  assert.deepEqual(p.mine, {});
  // 같은 옵션 이름이 두 상품에 = 프리필이 상품명을 붙인 줄 열쇠로 짝짓는다
  const dup = [{ ...PRODUCTS[0], name: '상품A' }, { ...JSON.parse(JSON.stringify(PRODUCTS[0])), name: '상품B' }];
  dup[1].options[0].guide = { text: 'B 블랙 가이드', images: [] };
  const dupKeys = require('../src/utils/orderToCampaignProjection').projectOrderToCampaign({ product_options_json: JSON.stringify(dup) }).options.map(o => o.key);
  assert.ok(dupKeys.includes('상품B|상품B 블랙'), JSON.stringify(dupKeys));
  // "옵션 없음" 라벨 줄 = 못 고침(프리필은 상품 자리 · 인트라넷은 옵션 자리 — 어디에 써도 되돌아간다) · 연결 저장도 그 칸을 막는다
  const none = [{ name: '단일', url: '', product_mode: 'opt', base: { pay: 5000, count: 3 }, options: [{ label: '옵션 없음', pay: 5000, count: 3 }], guide: { text: '상품 가이드', images: [] } }];
  p = E.planCampaignMoneyEdit({ baseState: { product_options_json: JSON.stringify(none), inflow_type: 'guide' }, camp: {},
    body: { options: [{ optKey: '단일', productName: '단일', unitKind: 'product', payAmount: 5000, inflowGuideHtml: '새 상품 가이드', inflowGuideImages: [] }], work_detail: { inflowType: 'guide' } },
    campOptions: [{ opt_key: '단일', product_name: '단일', unit_kind: 'product', pay_amount: 5000 }] });
  assert.equal(p.unmappable.length, 1);
  const nb = { product_options_json: JSON.stringify(none) };
  const nm = JSON.parse(JSON.stringify(none)); nm[0].options[0].guide = { text: 'x', images: [] };
  const npl = planSharedPatch({ base: nb, mine: { ...nb, product_options_json: JSON.stringify(nm) }, theirs: nb, origin: 'intranet' });
  assert.ok(npl.writes.some(w => !SP.writablePath(w, 'intranet')), '"옵션 없음" 옵션 가이드 = 막힘');
  // 상품 줄(옵션 없는 상품)은 상품 자리에
  const single = [{ name: '단일2', url: '', product_mode: 'none', base: { pay: 5000, count: 3 }, options: [], guide: { text: '상품 가이드', images: [] } }];
  p = E.planCampaignMoneyEdit({ baseState: { product_options_json: JSON.stringify(single), inflow_type: 'guide' }, camp: {},
    body: { options: [{ optKey: '단일2', productName: '단일2', unitKind: 'product', payAmount: 5000, inflowGuideHtml: '새 상품 가이드', inflowGuideImages: [] }], work_detail: { inflowType: 'guide' } },
    campOptions: [{ opt_key: '단일2', product_name: '단일2', unit_kind: 'product', pay_amount: 5000 }] });
  assert.deepEqual(p.unmappable, []); assert.deepEqual(JSON.parse(p.mine.product_options_json)[0].guide, { text: '새 상품 가이드', images: [] });
  // 비교 규칙: 드라이브 사진·링크 주소도 다름으로 센다
  assert.notEqual(G.canonGuideKey('<a href="https://a.com">여기</a>', []), G.canonGuideKey('<a href="https://b.com">여기</a>', []));
  assert.notEqual(G.canonGuideKey('참고<img src="https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345&sz=w1600">', []), G.canonGuideKey('참고', []));
}
console.log('bidirPhase6Guide: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const sid = `ro_p6_${stamp}`, camp = `camp_p6_${stamp}`;
  const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
  const admin = { authorization: 'Bearer ' + tok };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
  const dupIds = [], dupCamps = [];
  const optRow = async k => (await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 AND opt_key = $2', [camp, k])).rows[0];
  try {
    const pj = JSON.stringify(PRODUCTS);
    const payload = { source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 6단계 오더', recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00', review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '없음',
      product_url: 'https://www.coupang.com/vp/products/6', inflow_type: 'guide', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: pj, pay_amount: 100000 };
    const c1 = await call('POST', '/api/order/intake', payload);
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    let w = await wo();
    const proj = projectOrderToCampaign(w), pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end, delivery_type, review_type, work_kind,
         skip_weekends, channel, channel_custom, landing_url, daily_limit, participation_mode, status, work_detail)
       VALUES ($1, '가짜 6단계 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, TRUE, 'active', $12::jsonb)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type, proj.skip_weekends === '1', proj.channel, proj.landing_url,
        Number(proj.daily_limit) || 1, JSON.stringify({ inflowType: 'guide', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product })]);
    for (const o of pre.options) {
      // 공고 창이 저장하는 모양(글 + 끝 <img>)으로 넣는다 — 투영 모양과 달라도 같은 가이드로 연결돼야 한다
      const html = o.inflowGuideHtml + (o.inflowGuideImages || []).map(u => `<img src="${u}">`).join('');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order, inflow_guide_html, inflow_guide_images)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0, $9, $10::jsonb)`,
        [camp, o.optKey || o.productName, o.productName, o.unitKind, o.optionUrl, o.payAmount, o.recruitTotal, o.dailyLimit, html, JSON.stringify(o.inflowGuideImages || [])]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await SP.linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', '공고 창 모양 가이드도 같은 가이드로 연결: ' + JSON.stringify(ln.body));
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', '{"in2rw":"apply","push":"off","campaign_edit":"on"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    sw._resetBidirSwitchCacheForTest();
    let rev = 1;
    const putSource = async (patchFn, flags = { money: 1, guide: 1 }, extra = {}) => {
      const cur = await wo(); rev += 1;
      const p = JSON.parse(cur.product_options_json); patchFn(p);
      return call('PUT', `/api/order/intake/source/${sid}`, { ...payload, ...extra, source_revision: rev, idempotency_key: `${sid}:${rev}:g`, product_options_json: JSON.stringify(p),
        bidir: { base_sync_version: Number(cur.sync_version), op_id: `op_p6_${stamp}_${rev}`, ...flags } });
    };
    const whiteBefore = (await optRow('화이트')).inflow_guide_html;

    // 인트라넷: 블랙 가이드 수정 → 블랙 줄만 공고 · 화이트 줄은 공고 창 모양 그대로
    let r = await putSource(p => { p[0].options[0].guide = { text: '인트라넷이 고친 블랙 가이드', images: [IMG(4)] }; });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let black = await optRow('블랙');
    assert.match(black.inflow_guide_html, /인트라넷이 고친 블랙 가이드/); assert.deepEqual(black.inflow_guide_images, [IMG(4)]);
    assert.equal((await optRow('화이트')).inflow_guide_html, whiteBefore, '안 바뀐 줄은 다시 쓰지 않는다');

    // 옛 인트라넷(guide 표시 없음) — 옛 사본 가이드를 실어 와도 가이드는 안 건드린다(다른 칸은 저장)
    r = await putSource(p => { p[0].options[0].guide = { text: '옛 사본 가이드', images: [] }; }, { money: 1 }, { special_notes: '옛 인트라넷 저장' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(JSON.parse((await wo()).product_options_json)[0].options[0].guide.text, '인트라넷이 고친 블랙 가이드');
    assert.equal((await wo()).special_notes, '옛 인트라넷 저장');

    // 링크유입으로 바꾼 저장은 가이드를 안 싣는다 — "지웠다" 로 읽지 않는다(오더 가이드 보존)
    r = await putSource(p => { p[0].options.forEach(o => { delete o.guide; }); }, { money: 1, guide: 1 }, { inflow_type: 'link' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    w = await wo();
    assert.equal(w.inflow_type, 'link'); assert.ok(JSON.parse(w.product_options_json)[0].options[0].guide, '가이드 보존');
    r = await putSource(() => {}, { money: 1, guide: 1 }, { inflow_type: 'guide' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // 가이드유입인데 빈 가이드 = 409 · 쓰기 0
    r = await putSource(p => { delete p[0].options[1].guide; });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.reason, 'guide_missing');
    assert.ok(JSON.parse((await wo()).product_options_json)[0].options[1].guide, '오더도 그대로');
    rev -= 1;   // 거부된 저장의 원본 번호는 다시 쓴다(인트라넷이 실패분을 같은 번호로 다시 보낸다)

    // 공고 창: 화이트 가이드 고침 → 오더 guide · 인트라넷으로 보낼 줄
    const openEditor = async () => {
      const d = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
      const cc = d.body.data;
      return { title: cc.title, review_fee: cc.review_fee, max_slots: cc.max_slots, sort_order: cc.sort_order, deadline: cc.deadline, work_detail: { ...cc.work_detail },
        thumbnail_url: cc.thumbnail_url, time_range: cc.time_range, landing_url: cc.landing_url, channel: cc.channel, channel_custom: cc.channel_custom || '',
        window_start: String(cc.window_start || '').slice(0, 5), window_end: String(cc.window_end || '').slice(0, 5),
        options: d.body.options.map(o => ({ optKey: o.optKey, productName: o.productName, unitKind: o.unitKind, optionUrl: o.optionUrl, payAmount: o.payAmount, recruitTotal: o.recruitTotal,
          dailyLimit: o.dailyLimit, status: o.status, inflowGuideHtml: o.inflowGuideHtml || '', inflowGuideImages: o.inflowGuideImages || [] })),
        fee_schedules: (d.body.feeSchedules || []).map(s => ({ effectiveFrom: s.effectiveFrom, reviewFee: s.reviewFee })),
        bidir_base_sync_version: d.body.bidir.sync_version };
    };
    let ed = await openEditor();
    r = await call('PUT', `/api/campaign/admin/${camp}`, { ...ed, options: ed.options.map(o => (o.optKey === '화이트'
      ? { ...o, inflowGuideHtml: '공고 창에서 고친 화이트<br>둘째 줄<img src="' + IMG(5) + '">', inflowGuideImages: [IMG(5)] } : o)) }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shared.changed, ['유입가이드(가이드 상품 / 화이트)']);
    assert.deepEqual(JSON.parse((await wo()).product_options_json)[0].options[1].guide, { text: '공고 창에서 고친 화이트\n둘째 줄', images: [IMG(5)] });
    // 인트라넷으로 보낼 줄(이 버전) — 앞의 옛 인트라넷·링크유입 저장도 "받지 않은 칸" 이 있어 되돌려 보낼 줄을 쌓았다(사본 맞추기)
    const wNow = await wo();
    assert.equal((await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1 AND sync_version = $2 AND status = 'pending'`, [wNow.id, wNow.sync_version])).rows[0].n, 1);

    // 창을 연 뒤 인트라넷이 블랙 가이드를 고침 → 손대지 않은 창 저장이 옛 가이드로 되돌리지 않는다
    ed = await openEditor();
    r = await putSource(p => { p[0].options[0].guide = { text: '창을 연 뒤 인트라넷 수정', images: [] }; });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PUT', `/api/campaign/admin/${camp}`, { ...ed, title: '경합 뒤 제목' }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    black = await optRow('블랙');
    assert.match(black.inflow_guide_html, /창을 연 뒤 인트라넷 수정/); assert.doesNotMatch(black.inflow_guide_html, /인트라넷이 고친 블랙/);
    assert.equal(JSON.parse((await wo()).product_options_json)[0].options[0].guide.text, '창을 연 뒤 인트라넷 수정');
    // ── 같은 옵션 이름이 두 상품에(공고 줄 열쇠 = 상품명 붙은 이름) — 상품B 블랙 가이드만 고침 → 그 줄만 ──
    const sid2 = `ro_p6d_${stamp}`, camp2 = `camp_p6d_${stamp}`; dupIds.push(sid2); dupCamps.push(camp2);
    const dupP = [{ ...JSON.parse(JSON.stringify(PRODUCTS[0])), name: '상품A' }, { ...JSON.parse(JSON.stringify(PRODUCTS[0])), name: '상품B' }];
    r = await call('POST', '/api/order/intake', { ...payload, source_review_order_id: sid2, idempotency_key: `${sid2}:1:a`, product_options_json: JSON.stringify(dupP) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w2 = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid2])).rows[0];
    const pre2 = _woCampaignPrefill(JSON.parse(JSON.stringify(w2))), proj2 = projectOrderToCampaign(w2);
    await pool.query(`INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end, delivery_type, review_type, work_kind,
         skip_weekends, channel, channel_custom, landing_url, daily_limit, participation_mode, status, work_detail)
       VALUES ($1, '가짜 6단계 같은이름', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, TRUE, 'active', $12::jsonb)`,
      [camp2, w2.id, Number(proj2.recruit_total), Number(proj2.review_fee), pre2.time_range, proj2.delivery_type, proj2.review_type, proj2.skip_weekends === '1', proj2.channel, proj2.landing_url,
        Number(proj2.daily_limit) || 1, JSON.stringify({ inflowType: 'guide', reviewGuide: pre2.wd_review, specialNotes: pre2.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre2.wd_product })]);
    for (const o of pre2.options) {
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order, inflow_guide_html, inflow_guide_images)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0, $9, $10::jsonb)`,
        [camp2, o.optKey || o.productName, o.productName, o.unitKind, o.optionUrl, o.payAmount, o.recruitTotal, o.dailyLimit, o.inflowGuideHtml, JSON.stringify(o.inflowGuideImages || [])]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w2.id, camp2]);
    assert.equal((await SP.linkSharedOrder({ workOrderId: w2.id })).body.state, 'on');
    const cur2 = (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w2.id])).rows[0];
    const pj2 = JSON.parse(cur2.product_options_json); pj2[1].options[0].guide = { text: '상품B 블랙만 고침', images: [] };
    r = await call('PUT', `/api/order/intake/source/${sid2}`, { ...payload, source_review_order_id: sid2, source_revision: 2, idempotency_key: `${sid2}:2:g`, product_options_json: JSON.stringify(pj2),
      bidir: { base_sync_version: Number(cur2.sync_version), op_id: `op_p6d_${stamp}`, money: 1, guide: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rowsD = (await pool.query('SELECT opt_key, inflow_guide_html FROM campaign_options WHERE campaign_id = $1 ORDER BY opt_key', [camp2])).rows;
    assert.match(rowsD.find(x => x.opt_key === '상품B 블랙').inflow_guide_html, /상품B 블랙만 고침/, JSON.stringify(rowsD));
    assert.doesNotMatch(rowsD.find(x => x.opt_key === '상품A 블랙').inflow_guide_html, /상품B 블랙만 고침/);
    console.log('bidirPhase6Guide: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [[sid, ...dupIds]]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    for (const c2 of dupCamps) { await pool.query('DELETE FROM campaign_options WHERE campaign_id = $1', [c2]).catch(() => {}); await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [c2]).catch(() => {}); }
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_price_history WHERE campaign_id = $1', [camp]).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id = $1', [camp]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [camp]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1)', [ids]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirPhase6Guide: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
