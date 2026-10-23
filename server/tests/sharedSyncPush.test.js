/**
 * 양방향 4단계(결정 275) — 리뷰웹 → 인트라넷 공유 글 칸 송신.
 *   A. 순수 — 응답 판정 · 서명 · 기다림 · 보낼 본문(글 칸 11개만)
 *   B. 정적 — cron 등록 · 서명은 전용 비밀값 · 스위치·설정 없으면 안 보냄 · 인트라넷발은 합쳐졌을 때만 쌓고 그때는 "안다" 를 안 적음
 *   C. PGTEST_URL 있으면 진짜 PG — 리뷰웹발 저장 → 대기 줄 → 보냄(서명 검증되는 원문) → 반영 = delivered + 인트라넷이 안다 ·
 *      여러 버전이 쌓여도 최신 한 번 · held = 다시(점점 늦게) · receiver_off = 보류 · 404 = 중단 · 스위치 off·설정 없음 = 안 보냄 ·
 *      인트라넷발 저장: 보낸 값 그대로면 안 쌓음 / 리뷰웹 수정과 합쳐지면 쌓고 "안다" 를 옛 버전으로 둠
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const push = require('../src/services/sharedSyncPush.service');

// ── A. 순수 ──
{
  const { classifyResponse: cr, signBody, backoffMs, buildPushBody } = push;
  assert.deepEqual(cr(200, { ok: true, result: 'applied' }), { next: 'delivered', ack: true, result: 'applied' });
  assert.equal(cr(200, { ok: true, result: 'stale' }).next, 'delivered');
  assert.equal(cr(200, { ok: true, result: 'observed' }).next, 'parked', '관찰 모드는 반영이 아니다 — 켠 뒤 다시 보낸다');
  assert.equal(cr(503, { ok: false, code: 'receiver_off' }).next, 'parked');
  assert.equal(cr(401, { ok: false, code: 'bad_signature' }).next, 'parked');
  assert.equal(cr(404, { ok: false, code: 'unknown_source' }).next, 'dead');
  assert.equal(cr(409, { ok: false, code: 'held' }).next, 'retry', '못 보낸 인트라넷 수정 = 나중에 다시');
  assert.equal(cr(409, { ok: false, code: 'busy' }).next, 'retry');
  assert.equal(cr(409, { ok: false, code: 'remote_mismatch' }).next, 'dead', '다른 작업오더 — 다시 보내도 안 맞는다');
  assert.equal(cr(0, { code: 'network' }).next, 'retry');
  assert.equal(cr(500, null).next, 'retry');
  assert.equal(cr(200, { ok: false }).next, 'retry', '"ok" 만으로 반영이라 보지 않는다(결과를 꼭 말해야)');
  const sig = signBody('s3cret', '{"a":1}', 1792000000000);
  assert.equal(sig, 't=1792000000000,v1=' + crypto.createHmac('sha256', 's3cret').update('1792000000000.{"a":1}').digest('hex'));
  assert.equal(backoffMs(1), 15000); assert.equal(backoffMs(2), 30000); assert.equal(backoffMs(40), 600000, '최대 10분');
  const body = buildPushBody({ id: 'wo_1', source_review_order_id: 'ro_1', sync_version: '1792000000000001', review_guide: 'g', special_notes: 'n', recruit_count: 9, title: 't', guide_images: '[]' });
  assert.equal(body.sync_version, 1792000000000001, 'BIGINT 글자 → 숫자');
  // ★ 7단계-②(2026-10-20): 총모집도 보낸다(인원 양방향) — 인트라넷 고유 칸(작업명 등)은 여전히 보내지 않는다(검사 의미 유지)
  assert.deepEqual(Object.keys(body.view).sort(), ['guide_images', 'recruit_count', 'review_guide', 'special_notes'], '공유 칸만(작업명 등 인트라넷 고유는 보내지 않는다)');
  assert.ok(!Object.prototype.hasOwnProperty.call(body.view, 'title'));
  console.log('sharedSyncPush: pure passed');
}

// ── B. 정적 ──
{
  const cron = read('jobs/cron.js');
  assert.match(cron, /cron\.schedule\('\*\/15 \* \* \* \* \*', async \(\) => \{\s*try \{ await require\('\.\.\/services\/sharedSyncPush\.service'\)\.runSharedSyncPush\(\); \}/);
  const svc = read('services/sharedSyncPush.service.js');
  assert.match(svc, /if \(sw\.push !== 'on'\) return \{ skipped: 'switch_off' \}/);
  assert.match(svc, /if \(!url \|\| !secret\) return \{ skipped: 'config' \}/, '주소·전용 비밀값 없으면 보내지 않는다');
  assert.match(svc, /const secret = String\(env\.BIDIR_RW_TO_IN_SECRET/, '서명은 전용 비밀값(CS 중계 키 재사용 금지)');
  assert.ok(!/createHmac\([^)]*INTRANET_WEBHOOK_KEY/.test(svc));
  assert.match(svc, /FOR UPDATE SKIP LOCKED/);
  const sp = read('services/sharedPatch.service.js');
  assert.match(sp, /if \(p\.origin === 'intranet' && !_pushBackKeys\(p\.mine, next\)\.length\) sets\.push\(`intranet_acked_version/, '합쳐졌으면 "안다" 를 적지 않는다');
  // 리뷰웹발은 쓴 칸이 있을 때(오더·공고 맞추기는 쓴 칸이 없어도 — 오더를 공고 값으로 바꿨으니 인트라넷이 받아 가야 한다) · 인트라넷발은 합쳐졌을 때만
  assert.match(sp, /p\.origin !== 'intranet' \? \(plan\.writes\.length > 0 \|\| !!rec\) : \(plan\.writes\.length > 0 && _pushBackKeys\(p\.mine, next\)\.length > 0\)/, '인트라넷발은 합쳐졌을 때만 쌓는다(메아리 방지)');
  assert.match(sp, /const rec = p\.origin === 'reconcile' && p\.reconcile \? p\.reconcile : null;/, '맞추기 표시는 origin reconcile 에서만(인트라넷발에는 없다)');
  console.log('sharedSyncPush: static passed');
}

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder, applySharedPatch, readSharedState } = require('../src/services/sharedPatch.service');
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const sid = 'ro_push_' + stamp;
  const camp = 'camp_push_' + stamp;
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const payload = (rev, key, extra = {}) => ({
    source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: rev, idempotency_key: key,
    title: '가짜 송신 오더', recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
    review_guide: '[리뷰등록 가이드]\n사진 3장 올려주세요', special_notes: '주의 사항 없음',
    product_url: 'https://www.coupang.com/vp/products/1', inflow_type: 'link', purchase_channel: '쿠팡',
    delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE', ...extra });
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
  const ob = async () => (await pool.query('SELECT * FROM shared_sync_outbox WHERE work_order_id = $1 ORDER BY id', [(await wo()).id])).rows;
  const env = { INTRANET_ORDER_DELETE_WEBHOOK_URL: 'http://intranet.test/api/review-order/webhook', BIDIR_RW_TO_IN_SECRET: 'push-secret', INTRANET_WEBHOOK_KEY: 'cs-key' };
  // 가짜 인트라넷 — 서명을 실제로 검증하고, 정해 둔 답을 돌려준다.
  const sent = [];
  let reply = { status: 200, body: { ok: true, result: 'applied' } };
  const fakeFetch = async (url, init) => {
    const h = init.headers['X-Bidir-Signature'];
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h);
    assert.ok(m, '서명 머리 형식');
    assert.equal(m[2], crypto.createHmac('sha256', env.BIDIR_RW_TO_IN_SECRET).update(`${m[1]}.${init.body}`).digest('hex'), '원문에 대한 서명');
    assert.equal(init.headers['X-Review-Key'], 'cs-key', '기존 키도 함께(인트라넷 웹훅 입구 검사)');
    const b = JSON.parse(init.body);
    if (b.source_review_order_id === sid) sent.push(b);   // 같은 시험 DB 의 다른 오더 줄은 세지 않는다
    return { status: reply.status, json: async () => reply.body };
  };
  const run = (extra = {}) => push.runSharedSyncPush({ db: pool, env, fetchImpl: fakeFetch, ...extra });
  const due = async () => pool.query(`UPDATE shared_sync_outbox SET next_at = NOW() WHERE work_order_id = $1 AND status = 'pending'`, [(await wo()).id]);
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    const c1 = await call('POST', '/api/order/intake', payload(1, `${sid}:1:a`));
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    let w = await wo();
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, daily_limit, participation_mode, status, work_detail)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, TRUE, 'active', $12::jsonb)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, Number(proj.daily_limit) || 0,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [] })]);
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    const v0 = Number(ln.body.sync_version);

    // ── 스위치 off = 안 보냄(쌓이기만) ──
    await setSwitch('{"in2rw":"apply","push":"off"}');
    const a1 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 1' }, baseVersion: v0, origin: 'rw_admin', actor: '관리자' });
    assert.equal(a1.status, 200, JSON.stringify(a1.body));
    const v1 = Number(a1.body.sync_version);
    assert.equal((await ob()).length, 1, '리뷰웹발 저장 = 대기 줄 1');
    assert.deepEqual(await run(), { skipped: 'switch_off' });
    await setSwitch('{"in2rw":"apply","push":"on"}');
    assert.deepEqual(await run({ env: { ...env, BIDIR_RW_TO_IN_SECRET: '' } }), { skipped: 'config' }, '전용 비밀값 없으면 안 보냄');
    assert.equal((await ob())[0].status, 'pending');

    // ── 두 번째 리뷰웹 저장 → 줄 2개 → 최신 한 번만 보냄 → 반영 = 둘 다 끝 + 인트라넷이 안다 ──
    const a2 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), review_guide: '[리뷰등록 가이드]\n리뷰웹 2' }, baseVersion: v1, origin: 'rw_admin', actor: '관리자' });
    const v2 = Number(a2.body.sync_version);
    assert.equal((await ob()).length, 2);
    await run();
    assert.equal(sent.length, 1, '오더당 한 번');
    assert.equal(sent[0].sync_version, v2, '가장 새 버전');
    assert.equal(sent[0].source_review_order_id, sid);
    assert.equal(sent[0].view.special_notes, '리뷰웹 1'); assert.equal(sent[0].view.review_guide, '[리뷰등록 가이드]\n리뷰웹 2');
    assert.ok(!('title' in sent[0].view), '인트라넷 고유 칸(작업명)은 보내지 않는다');
    assert.equal(Number(sent[0].view.recruit_count), Number((await wo()).recruit_count), '7단계-②: 총모집은 보낸다');
    assert.deepEqual((await ob()).map(r => r.status), ['delivered', 'delivered']);
    assert.equal(Number((await wo()).intranet_acked_version), v2, '반영됐으면 인트라넷이 이 버전을 안다');

    // ── held(인트라넷에 못 보낸 수정) = 다시, 점점 늦게 · 그다음 반영 ──
    const a3 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 3' }, baseVersion: v2, origin: 'rw_admin', actor: '관리자' });
    const v3 = Number(a3.body.sync_version);
    reply = { status: 409, body: { ok: false, code: 'held' } };
    await run();
    let row = (await ob()).find(r => Number(r.sync_version) === v3);
    assert.equal(row.status, 'pending'); assert.equal(row.last_error, 'held');
    assert.ok(new Date(row.next_at).getTime() > Date.now() + 10_000, '바로 다시 보내지 않는다');
    sent.length = 0;
    await run();
    assert.equal(sent.length, 0, '기다리는 동안은 안 보냄');
    await due();
    reply = { status: 200, body: { ok: true, result: 'applied' } };
    await run();
    row = (await ob()).find(r => Number(r.sync_version) === v3);
    assert.equal(row.status, 'delivered'); assert.equal(Number(row.attempts), 2);

    // ── receiver_off = 보류 · 404 = 중단 ──
    const a4 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 4' }, baseVersion: v3, origin: 'rw_admin', actor: '관리자' });
    reply = { status: 503, body: { ok: false, code: 'receiver_off' } };
    await run();
    assert.equal((await ob()).find(r => Number(r.sync_version) === Number(a4.body.sync_version)).status, 'parked');
    const a5 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 5' }, baseVersion: Number(a4.body.sync_version), origin: 'rw_admin', actor: '관리자' });
    reply = { status: 404, body: { ok: false, code: 'unknown_source' } };
    await run();
    assert.equal((await ob()).find(r => Number(r.sync_version) === Number(a5.body.sync_version)).status, 'dead');
    const v5 = Number(a5.body.sync_version);
    await pool.query('UPDATE work_orders SET intranet_acked_version = $2 WHERE id = $1', [w.id, v5]);   // 시험: 인트라넷이 v5 를 받았다고 둔다

    // ── 인트라넷발 저장: 보낸 값 그대로(창이 리뷰웹 값으로 열림) → 안 쌓음 · "안다" = 새 버전 ──
    const put = async (rev, key, extra, bidir) => call('PUT', `/api/order/intake/source/${sid}`, { ...payload(rev, key, extra), bidir });
    w = await wo();
    const same = { review_guide: w.review_guide, special_notes: w.special_notes };
    const before = (await ob()).length;
    const i1 = await put(2, `${sid}:2:b`, { ...same, purchase_time: '14:00 ~ 17:00' }, { base_sync_version: v5 });
    assert.equal(i1.status, 200, JSON.stringify(i1.body));
    assert.equal((await ob()).length, before, '보낸 값 그대로 저장됐으면 되돌려 보내지 않는다(메아리 없음)');
    assert.equal(i1.body.push_back, false, '인트라넷이 이 버전을 자기 사본 버전으로 적어도 된다는 신호');
    const v6 = Number((await wo()).sync_version);
    assert.equal(Number((await wo()).intranet_acked_version), v6);

    // ── 그 사이 리뷰웹이 특이사항을 고침 → 옛 창(특이사항은 옛 값)에서 다른 칸만 저장 → 합쳐짐 → 쌓고 "안다" 는 그대로 ──
    const a7 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 7' }, baseVersion: v6, origin: 'rw_admin', actor: '관리자' });
    assert.equal(a7.status, 200);
    await pool.query(`UPDATE shared_sync_outbox SET status = 'delivered' WHERE work_order_id = $1`, [w.id]);   // 시험: a7 은 이미 갔다고 둔다
    const ackBefore = Number((await wo()).intranet_acked_version);
    const i2 = await put(3, `${sid}:3:c`, { ...same, purchase_time: '15:00 ~ 18:00' }, { base_sync_version: v6 });
    assert.equal(i2.status, 200, JSON.stringify(i2.body));
    w = await wo();
    assert.equal(w.special_notes, '리뷰웹 7', '손대지 않은 칸은 리뷰웹 값');
    const v8 = Number(w.sync_version);
    const pend = (await ob()).filter(r => r.status === 'pending');
    assert.deepEqual(pend.map(r => Number(r.sync_version)), [v8], '합쳐진 결과를 인트라넷으로 되돌려 보낼 줄');
    assert.equal(Number(w.intranet_acked_version), ackBefore, '합쳐졌으면 인트라넷 사본은 아직 옛 값 — "안다" 를 올리지 않는다');
    assert.equal(i2.body.push_back, true, '합쳐졌으면 인트라넷은 버전을 적지 않는다(되돌려 보낸 것이 stale 로 버려지지 않게)');
    sent.length = 0;
    reply = { status: 200, body: { ok: true, result: 'applied' } };
    await run();
    assert.equal(sent[0].view.special_notes, '리뷰웹 7');
    assert.equal(sent[0].view.purchase_time, '15:00 ~ 18:00');
    assert.equal(Number((await wo()).intranet_acked_version), v8, '받아 간 뒤에 "안다" 를 올린다');

    // ── 보류는 30분 뒤 다시 확인(시도 횟수 안 늘림) — 켜진 뒤 저절로 간다 · 더 새 버전이 가면 옛 보류도 끝 ──
    const a8 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 8' }, baseVersion: v8, origin: 'rw_admin', actor: '관리자' });
    const v8b = Number(a8.body.sync_version);
    reply = { status: 503, body: { ok: false, code: 'receiver_off' } };
    await run();
    let pr = (await ob()).find(r => Number(r.sync_version) === v8b);
    assert.equal(pr.status, 'parked');
    const att = Number(pr.attempts);
    sent.length = 0; await run();
    assert.equal(sent.length, 0, '30분 안에는 다시 안 감');
    await pool.query(`UPDATE shared_sync_outbox SET updated_at = NOW() - INTERVAL '31 minutes' WHERE id = $1`, [pr.id]);
    reply = { status: 200, body: { ok: true, result: 'applied' } };
    await run();
    pr = (await ob()).find(r => Number(r.sync_version) === v8b);
    assert.equal(pr.status, 'delivered', '수신이 켜지면 보류분이 저절로 간다');
    assert.equal(Number(pr.attempts), att, '보류 재확인은 시도 횟수에 안 넣는다');
    const v8c = v8b;

    // ── 같은 프로세스에서 겹쳐 돌면 뒤 것은 건너뜀 ──
    let release; const gate = new Promise(r => { release = r; });
    const slow = async (u, i) => { await gate; return fakeFetch(u, i); };
    await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 8-2' }, baseVersion: v8c, origin: 'rw_admin', actor: '관리자' });
    const first = run({ fetchImpl: slow });
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(await run(), { skipped: 'running' });
    release(); await first;
    const v8d = Number((await wo()).sync_version);

    // ── 끊긴 처리기(sending 5분 넘음)는 다시 가져간다 · 연결 끊긴 오더 = 중단 ──
    const a9 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 9' }, baseVersion: v8d, origin: 'rw_admin', actor: '관리자' });
    await pool.query(`UPDATE shared_sync_outbox SET status = 'sending', updated_at = NOW() - INTERVAL '6 minutes' WHERE work_order_id = $1 AND sync_version = $2`, [w.id, a9.body.sync_version]);
    await run();
    assert.equal((await ob()).find(r => Number(r.sync_version) === Number(a9.body.sync_version)).status, 'delivered');
    const a10 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹 10' }, baseVersion: Number(a9.body.sync_version), origin: 'rw_admin', actor: '관리자' });
    await pool.query(`UPDATE work_orders SET bidir_state = 'off' WHERE id = $1`, [w.id]);
    await run();
    assert.equal((await ob()).find(r => Number(r.sync_version) === Number(a10.body.sync_version)).status, 'dead');
    console.log('sharedSyncPush: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id=$1', [sid]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE source_review_order_id=$1', [sid]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('sharedSyncPush: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
