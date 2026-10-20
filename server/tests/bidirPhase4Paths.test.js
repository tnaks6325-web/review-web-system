/**
 * 양방향 4단계-3(결정 263) — 옛 경로 막기 · 새 공고 발행 뒤 연결 판정 (PGTEST_URL 있을 때 진짜 PG + 실제 라우트).
 *   ① 옛 작업오더 ID 직접 수정(PUT /intake/:id): 연결+apply 면 공유 칸 409(쓰기 0) · 공유 칸 아닌 칸은 종전대로 · 스위치 off 면 종전대로
 *   ② 인트라넷 오더로 공고 발행(POST /admin/create, source_work_order_id): 같으면 on + 스냅숏 · 다르면 diverged · 스위치 off 면 판정 안 함
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

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirPhase4Paths: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
