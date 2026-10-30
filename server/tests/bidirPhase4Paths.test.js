/**
 * 양방향 4단계-3(결정 275) — 옛 경로 막기 · 새 공고 발행 뒤 연결 판정 (PGTEST_URL 있을 때 진짜 PG + 실제 라우트).
 *   ① 옛 작업오더 ID 직접 수정(PUT /intake/:id): 연결+apply 면 공유 칸 409(쓰기 0) · 공유 칸 아닌 칸은 종전대로 · 스위치 off 면 종전대로
 *   ② 인트라넷 오더로 공고 발행(POST /admin/create, source_work_order_id): 같으면 on + 스냅숏 · 다르면 diverged · 스위치 off 면 판정 안 함
 *   ③ 결정 313 발행 자동 맞추기(publish_reconcile on): 다르면 오더를 공고 값으로 맞추고 on · 못 맞추는 칸이면 쓰기 0 + 이유
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const admin = { authorization: 'Bearer ' + tok };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const sids = [];
  const intake = async (tag, extra = {}) => {
    const sid = `ro_p4_${tag}_${stamp}`; sids.push(sid);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 4단계 오더 ' + tag, recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/7',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
  };
  /** 발행 화면이 하듯 프리필 값 그대로 공고를 만든다. */
  const publish = async (w, over = {}, wd = {}) => {
    const p = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    return call('POST', '/api/campaign/admin/create', {
      title: p.title || w.title, channel: p.channel, channel_custom: '', time_range: p.time_range, review_fee: p.review_fee,
      recruit_total: p.recruit_total || w.recruit_count, max_slots: p.max_slots, delivery_type: p.delivery_type, review_type: p.review_type,
      work_kind: p.work_kind || 'review', landing_url: p.landing_url, thumbnail_url: p.thumbnail_url, skip_weekends: !!p.skip_weekends,
      daily_limit: p.daily_limit || 0, participation_mode: false, status: 'draft', source_work_order_id: w.id,
      work_detail: { inflowType: 'link', reviewGuide: p.wd_review, specialNotes: p.wd_notes, reviewGuideImages: [], specialNotesImages: [], ...wd },
      ...over,
    }, admin);
  };
  const campIds = [];
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    // ── ② 발행 뒤 연결 판정 ──
    await setSwitch('{"in2rw":"off"}');
    const wOff = await intake('off');
    const cOff = await publish(wOff);
    assert.equal(cOff.status, 200, JSON.stringify(cOff.body)); campIds.push(cOff.body.data.id);
    assert.equal(cOff.body.bidirLink, undefined, '스위치 off = 판정 안 함');
    assert.equal((await pool.query('SELECT bidir_state FROM work_orders WHERE id=$1', [wOff.id])).rows[0].bidir_state, 'off');

    await setSwitch('{"in2rw":"apply"}');
    const wSame = await intake('same');
    const cSame = await publish(wSame);
    assert.equal(cSame.status, 200, JSON.stringify(cSame.body)); campIds.push(cSame.body.data.id);
    assert.equal(cSame.body.bidirLink.state, 'on', '프리필 그대로 발행 = 같음 = 연결: ' + JSON.stringify(cSame.body.bidirLink));
    const ws = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [wSame.id])).rows[0];
    assert.equal(ws.bidir_state, 'on');
    assert.equal((await pool.query('SELECT count(*)::int n FROM work_order_shared_snapshots WHERE work_order_id=$1 AND sync_version=$2', [ws.id, ws.sync_version])).rows[0].n, 1, '연결 스냅숏');

    const wDiff = await intake('diff');
    const cDiff = await publish(wDiff, { time_range: '10:00 ~ 12:00' });
    assert.equal(cDiff.status, 200, JSON.stringify(cDiff.body)); campIds.push(cDiff.body.data.id);
    assert.equal(cDiff.body.bidirLink.state, 'diverged', '발행 때 값을 바꾸면 = 다름 = 직원이 고를 때까지 종전 동작');
    assert.equal(cDiff.body.bidirLink.autoReconciled, undefined, '발행 자동 맞추기 스위치 off = 시도하지 않음(종전 동작)');

    // ── ③ 결정 313 — 발행 자동 맞추기(publish_reconcile on): 다르면 오더를 공고 값으로 맞추고 연결 · 못 맞추면 아무것도 안 바꾸고 이유 ──
    await setSwitch('{"in2rw":"apply","push":"on","publish_reconcile":"on"}');
    const wAuto = await intake('auto');
    const cAuto = await publish(wAuto, { time_range: '10:00 ~ 12:00' });
    assert.equal(cAuto.status, 200, JSON.stringify(cAuto.body)); campIds.push(cAuto.body.data.id);
    assert.equal(cAuto.body.bidirLink.state, 'on', '자동 맞추기 = 연결: ' + JSON.stringify(cAuto.body.bidirLink));
    assert.equal(cAuto.body.bidirLink.autoReconciled, true);
    assert.ok(cAuto.body.bidirLink.labels.includes('구매시간'), '맞춘 칸 이름을 화면에 준다: ' + JSON.stringify(cAuto.body.bidirLink.labels));
    const wa = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [wAuto.id])).rows[0];
    assert.equal(wa.bidir_state, 'on');
    assert.equal(String(wa.purchase_time).replace(/\s/g, ''), '10:00~12:00', '오더가 공고 값으로(띄어쓰기는 오더 저장 모양)');
    assert.equal(String((await pool.query('SELECT time_range FROM recruit_campaigns WHERE id=$1', [cAuto.body.data.id])).rows[0].time_range).replace(/\s/g, ''), '10:00~12:00', '공고는 그대로');
    assert.ok((await pool.query('SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id=$1', [wAuto.id])).rows[0].n >= 1, '인트라넷으로 보낼 거리가 쌓인다');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM work_order_shared_snapshots WHERE work_order_id=$1 AND op_id=$2`, [wAuto.id, 'publish-' + cAuto.body.data.id])).rows[0].n, 1, '발행 맞추기 기록(재전송 열쇠)');

    const wLock = await intake('lock');
    const cLock = await publish(wLock, { time_range: '10:00 ~ 12:00', work_kind: 'blog', daily_limit: 3 });
    assert.equal(cLock.status, 200, JSON.stringify(cLock.body)); campIds.push(cLock.body.data.id);
    assert.equal(cLock.body.bidirLink.state, 'diverged', '못 맞추는 칸(체험단 종류) = 연결 안 함: ' + JSON.stringify(cLock.body.bidirLink));
    assert.equal(cLock.body.bidirLink.autoReconciled, false);
    assert.equal(cLock.body.bidirLink.code, 'reconcile_blocked');
    assert.deepEqual(cLock.body.bidirLink.labels, ['체험단 종류'], '못 바꾸는 칸만 알린다: ' + JSON.stringify(cLock.body.bidirLink));
    const wl = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [wLock.id])).rows[0];
    assert.equal(wl.bidir_state, 'diverged');
    assert.equal(wl.purchase_time, wLock.purchase_time, '못 맞추면 오더는 하나도 안 바뀐다(fail-closed)');
    assert.equal((await pool.query('SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id=$1', [wLock.id])).rows[0].n, 0, '보낼 거리도 없다');
    // 실제로 갈라졌던 모양(2026-10-30 조사 3건) — 발행 창에서 상품 이름에 번호를 붙이고 구매시간을 고쳤다. 상품 이름은 시스템마다 따로(결정 285).
    const prodJ = JSON.stringify(['사우나', '베개커버 40x60cm'].map(name => ({ name, url: '', option_schema_version: 2, product_mode: 'none', base: { pay: 9000, count: 3, daily: 1, review_type_mix: [] }, options: [] })));
    const wName = await intake('name', { recruit_count: 6, daily_count: 2, product_options_json: prodJ, product_option: '인트라넷 문장', pay_amount: 9000 * 6 });
    const preN = _woCampaignPrefill(JSON.parse(JSON.stringify(wName)));
    const cName = await publish(wName, { time_range: '자유시간대', recruit_total: 6, daily_limit: 2,
      options: preN.options.map((o, i) => ({ ...o, productName: `${i + 1}.${o.productName}`, optKey: `${i + 1}.${o.productName}` })) });   // 상품 단위 줄 = 화면이 상품 이름을 열쇠로 보낸다
    assert.equal(cName.status, 200, JSON.stringify(cName.body)); campIds.push(cName.body.data.id);
    assert.equal(cName.body.bidirLink.autoReconciled, true, '번호 붙인 상품 이름 + 구매시간 = 자동 맞추기: ' + JSON.stringify(cName.body.bidirLink));
    const wn = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [wName.id])).rows[0];
    assert.equal(wn.bidir_state, 'on');
    assert.deepEqual(cName.body.bidirLink.labels, ['구매시간'], '안내에 상품 이름 칸은 없다(인트라넷 이름은 그대로라 「맞췄다」 가 틀린 말)');
    // 리뷰웹 오더 사본은 공고(리뷰웹) 이름을 쓴다 — 인트라넷 수신기가 「이름 서로 포함」 짝으로 인트라넷 이름을 지킨다(결정 285 · 인트라넷 review-order-bidir-keep-names ①)
    assert.deepEqual(JSON.parse(wn.product_options_json).map(p => p.name), ['1.사우나', '2.베개커버 40x60cm'], '리뷰웹 사본 = 리뷰웹 이름(결정 285)');
    assert.deepEqual((await pool.query('SELECT product_name FROM campaign_options WHERE campaign_id=$1 ORDER BY sort_order, id', [cName.body.data.id])).rows.map(r => r.product_name), ['1.사우나', '2.베개커버 40x60cm'], '공고 이름도 그대로');
    console.log('bidirPhase4Paths: 이름 사례 맞춘 칸 =', cName.body.bidirLink.labels.join(', '), '· 오더 상품 =', JSON.parse(wn.product_options_json).map(p => p.name).join(' / '));
    await setSwitch('{"in2rw":"apply"}');

    // ── ① 옛 ID 직접 수정 ──
    const put = (id, body) => call('PUT', `/api/order/intake/${id}`, body);
    const blocked = await put(ws.id, { special_notes: '옛 경로로 몰래' });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'bidir_use_source', JSON.stringify(blocked.body));
    assert.equal((await pool.query('SELECT special_notes FROM work_orders WHERE id=$1', [ws.id])).rows[0].special_notes, '주의 없음', '쓰기 0');
    const title = await put(ws.id, { title: '옛 경로 제목' });
    assert.equal(title.status, 409, '작업명도 공유 칸(인트라넷 고유) — 원본 수정으로만');
    for (const sneak of [{ courier_proxy: true }, { product_option: '1. 몰래 바꾼 상품' }, { delivery_type: '빈박스' }]) {
      const r = await put(ws.id, sneak);
      assert.equal(r.body.code, 'bidir_use_source', '배송·상품 글 사본도 막는다: ' + JSON.stringify(sneak));
    }
    const memo = await put(ws.id, { chat_room_url: 'https://open.kakao.com/o/test' });
    assert.notEqual(memo.body.code, 'bidir_use_source', '공유 칸이 아니면 종전대로: ' + JSON.stringify(memo.body));
    await setSwitch('{"in2rw":"off"}');
    const legacy = await put(ws.id, { special_notes: '스위치 끄면 종전대로' });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    console.log('bidirPhase4Paths: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id = ANY($1)', [campIds]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id = ANY($1)', [campIds]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1)', [ids]).catch(() => {});
  }
}

/** 결정 313 — 발행 창 안내(index-recruit.js) 블록을 그대로 떼어 돌린다: 맞춤 = ✅ + 칸 · 못 맞춤 = ⚠ + 이유 + 맞출 곳 · 수정 저장·연결 정보 없음 = 말 없음. */
function noticeBlock() {
  const fs = require('fs'), vm = require('vm'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
  const a = src.indexOf('if (saved && saved.bidirLink && !_recruitEditId) {');
  assert.ok(a > 0, '발행 창이 bidirLink 를 읽는다');
  let i = src.indexOf('{', a), depth = 0, b = -1;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { b = i + 1; break; } }
  const run = (saved, editId = null) => { const ctx = { saved, _recruitEditId: editId, _changed: [] }; vm.runInNewContext(src.slice(a, b), ctx); return ctx._changed; };
  const ok = run({ bidirLink: { state: 'on', autoReconciled: true, labels: ['구매시간', '리뷰비', '총모집', '썸네일'] } });
  assert.equal(ok.length, 1); assert.ok(/^✅ 인트라넷 리뷰오더도 이 공고 값으로 맞췄습니다 \(구매시간, 리뷰비, 총모집 외 1개\)/.test(ok[0]), ok[0]);
  const no = run({ bidirLink: { state: 'diverged', code: 'reconcile_blocked', autoReconciled: false, autoReason: '접수 뒤에는 바꿀 수 없는 칸이라 맞출 수 없습니다', labels: ['체험단 종류'] } });
  assert.ok(/^⚠ 인트라넷 리뷰오더와 값이 달라 아직 연결되지 않았습니다 \(체험단 종류\) — 접수 뒤에는 바꿀 수 없는 칸이라 맞출 수 없습니다\. 개발 담당에게 알려 주세요$/.test(no[0]), '못 바꾸는 칸 = 할 일 하나(맞추기 화면 안내 안 함): ' + no[0]);
  const stale = run({ bidirLink: { state: 'diverged', code: 'reconcile_stale', autoReconciled: false, autoReason: '화면을 연 뒤 이 작업의 값이 바뀌었습니다.', labels: ['구매시간'] } });
  assert.ok(/^⚠ .* \(구매시간\) — 화면을 연 뒤 이 작업의 값이 바뀌었습니다\. 작업보드 「⚠ 오더·공고 다름」에서 맞춰 주세요$/.test(stale[0]), '그 밖의 이유 = 맞추기 화면으로(마침표 겹침 없음): ' + stale[0]);
  const old = run({ bidirLink: { state: 'diverged', code: '' } });
  assert.ok(/^⚠ 인트라넷 리뷰오더와 값이 달라 아직 연결되지 않았습니다\. 작업보드/.test(old[0]), '옛 서버(자동 맞추기 모름)의 diverged 도 사실대로: ' + old[0]);
  assert.deepEqual(run({ bidirLink: { state: 'on', code: '' } }), [], '처음부터 같아 연결 = 말 없음(종전)');
  assert.deepEqual(run({}), [], '연결 정보 없음 = 말 없음');
  assert.deepEqual(run({ bidirLink: { state: 'diverged' } }, 'camp_x'), [], '수정 저장은 대상 아님');
  console.log('bidirPhase4Paths: 발행 창 안내 passed');
}

(async () => {
  noticeBlock();
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirPhase4Paths: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
