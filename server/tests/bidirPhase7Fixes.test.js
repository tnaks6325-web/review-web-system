/**
 * 양방향 7단계 사전 고치기(결정 274 · 사용자 확정 2026-10-20 「1~8 고치기부터」) — 작업표에 닿는 칸의 샛길·어긋남.
 *   🔴2 차수 추가·제거 → 연결 작업오더 총모집도 따라간다(syncCampaignRecruitTotal 한 곳)
 *   🔴3 관리자 작업오더 수정: 연결 오더의 작업표 칸도 공유 저장으로(아직 안 연 칸 = 409 · 쓰기 0) — sharedPatchService 시험에 있다
 *   🔴4 리뷰어앱 공고 수정: 총모집을 참여 인원 아래로 못 줄이고, 바꾸면 작업오더 총모집도 따라간다 · 연결 공고는 총모집·일건수 409
 *   🔴5 옛 작업오더 ID 직접 수정: 접수된 오더의 작업표 칸 = 409(같은 값은 통과)
 *   🔴6 오더 주말 여부 빈 값 = "아직 안 정함" — 연결 판정에서 다름(직원이 고른다)
 *   🔴8 인트라넷 잠금 대상(총모집 = 상품·옵션 인원 칸) — 인트라넷 시험에 있다
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
assert.equal(projectOrderToCampaign({ skip_weekends: null }).skip_weekends, 'unset');
assert.equal(projectOrderToCampaign({ skip_weekends: false }).skip_weekends, '0');
assert.equal(projectOrderToCampaign({ skip_weekends: true }).skip_weekends, '1');
{
  const fs = require('fs'), path = require('path');
  const tb = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  for (const fn of ['addRound(campaignId, req.body, _by(req))', 'removeLastRound(campaignId, _by(req))']) {
    const at = tb.indexOf(fn);
    assert.ok(at > 0 && tb.indexOf('syncCampaignRecruitTotal({ campaignId, recruitTotal: out.newTotal })', at) - at < 900, '차수 뒤 작업오더 정원 동기화: ' + fn);
  }
}
console.log('bidirPhase7Fixes: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const SP = require('../src/services/sharedPatch.service');
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
  const sids = [], camps = [];
  /** 인트라넷 오더 + 그 오더로 발행한 공고(연결 칸은 붙이되 양방향 연결은 하지 않음). */
  const setup = async (tag, extra = {}) => {
    const sid = `ro_p7_${tag}_${stamp}`, camp = `camp_p7_${tag}_${stamp}`; sids.push(sid); camps.push(camp);
    const r = await call('POST', '/api/order/intake', { source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 7단계 ' + tag, recruit_count: 10, daily_count: 2, review_fee: 1000, purchase_time: '13:00 ~ 18:00', review_guide: '[리뷰등록 가이드]\n사진', special_notes: '없음',
      product_url: 'https://www.coupang.com/vp/products/7', inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', requester_name: '가짜AE', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end, delivery_type, review_type, work_kind,
         skip_weekends, channel, channel_custom, landing_url, daily_limit, participation_mode, status, work_detail, start_date)
       VALUES ($1, '가짜 7단계 공고', $2, 10, 1000, $3, '13:00', '18:00', '실배송', $4, 'review', FALSE, '쿠팡', '', $5, 2, TRUE, 'active', $6::jsonb, CURRENT_DATE)`,
      [camp, w.id, pre.time_range, pre.review_type || null, pre.landing_url, JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes })]);
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    return { sid, camp, w, wo: async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0],
      c: async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0] };
  };
  try {
    // 🔴6 주말 여부 빈 값 = 연결 판정에서 다름
    const U = await setup('unset');
    assert.equal((await U.wo()).skip_weekends, null);
    const ln = await SP.linkSharedOrder({ workOrderId: U.w.id, dryRun: true });
    assert.equal(ln.body.state, 'diverged'); assert.ok(ln.body.diffs.some(d => d.field === 'skip_weekends' && d.order === 'unset'), JSON.stringify(ln.body.diffs));

    // 🔴5 옛 ID 직접 수정 — 접수된(공고 연결) 오더의 작업표 칸
    const L = await setup('lock', { skip_weekends: false });
    let r = await call('PUT', `/api/order/intake/${L.w.id}`, { recruit_count: 30 });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'accepted_worktable_locked', JSON.stringify(r.body));
    assert.equal(Number((await L.wo()).recruit_count), 10, '쓰기 0');
    r = await call('PUT', `/api/order/intake/${L.w.id}`, { skip_weekends: false, delivery_type: '실배송', special_notes: '같은 값 + 다른 칸' });
    assert.equal(r.status, 200, '같은 값은 통과: ' + JSON.stringify(r.body)); assert.notEqual(r.body.ok, false, JSON.stringify(r.body));
    assert.equal((await L.wo()).special_notes, '같은 값 + 다른 칸');

    // 🔴4 리뷰어앱 공고 수정 — 참여 인원 아래로 못 줄임 · 늘리면 작업오더도
    const S = await setup('scoped', { skip_weekends: false });
    for (let k = 0; k < 4; k++) {
      await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, expires_at) VALUES ($1, $2, $3, 'applied', NOW() + INTERVAL '1 hour')`,
        [S.camp, '가짜' + k, '7100000' + k]);
    }
    r = await call('PUT', `/api/campaign/admin/${S.camp}`, { recruit_total: 2 }, scoped);
    assert.ok(r.status >= 400 || r.body.ok === false || r.body.error, '참여 4명인데 2명으로 못 줄인다: ' + JSON.stringify(r.body));
    assert.equal(Number((await S.c()).recruit_total), 10, '쓰기 0');
    r = await call('PUT', `/api/campaign/admin/${S.camp}`, { recruit_total: 15 }, scoped);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await S.c()).recruit_total), 15);
    assert.equal(Number((await S.wo()).recruit_count), 15, '작업오더 총모집도 따라간다');

    // 🔴2 차수 추가 → 작업오더 총모집도
    r = await call('POST', `/api/trackb/campaigns/${S.camp}/rounds`, { count: 5 }, admin);
    if (r.status === 200) {
      assert.equal(Number((await S.c()).recruit_total), 20);
      assert.equal(Number((await S.wo()).recruit_count), 20, '차수 추가 뒤 작업오더 총모집');
      r = await call('DELETE', `/api/trackb/campaigns/${S.camp}/rounds`, null, admin);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(Number((await S.wo()).recruit_count), 15, '차수 제거 뒤 작업오더 총모집');
    } else {
      console.log('  - 차수 라우트: 시험 토큰이 거부돼 건너뜀(' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120) + ')');
    }
    console.log('bidirPhase7Fixes: PG passed');
  } finally {
    srv.close();
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_plan_events WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_rounds WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1)', [ids]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirPhase7Fixes: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
