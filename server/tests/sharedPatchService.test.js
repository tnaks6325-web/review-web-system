/**
 * 양방향 3단계(결정 263) — 공유 저장(applySharedPatch)·연결(linkSharedOrder)·원본 수정 분기·관리자 수정 분기.
 *   A. 정적 — 잠금 순서(L1 → 오더 행 → 공고 행) · 부분 반영 금지(409 다섯 갈래 모두 쓰기 전) · 비상 스위치 · 스위치 off 면 종전 경로
 *   B. PGTEST_URL 있으면 진짜 PG + 실제 라우트(인트라넷이 보내는 그대로):
 *      연결(같으면 on · 마감 공고 거부) · 글 칸 수정 → 오더·공고 함께 · 버전·스냅숏 · 원본 번호 규칙 · 같은 시도 멱등 ·
 *      그 사이 리뷰웹이 같은 칸을 고침 → 나중 저장 값 + 덮인 값 알림(기본 정책은 여전히 쓰기 0) · 아직 못 고치는 칸 → 막힘(쓰기 0) ·
 *      공고가 거부(읽지 못한 구매시간·가이드 없는 가이드유입) → 오더까지 되돌림 · 관리자 수정(고유 칸 막힘·글 칸 반영) ·
 *      스위치 off = 종전 경로 · 같은 오더 동시 저장 반복 → 교착 0 · 공고 행을 쥐는 시간
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

// ── A. 정적 ──
{
  const svc = read('services/sharedPatch.service.js');
  const fn = svc.slice(svc.indexOf('async function applySharedPatch('), svc.indexOf('async function linkSharedOrder('));
  const at = (re) => { const m = re.exec(fn); assert.ok(m, '못 찾음: ' + re); return m.index; };
  const L1 = at(/lockWorkOrderCampaigns\(client, \[p\.workOrderId\]\)/);
  const woLock = at(/SELECT \* FROM work_orders WHERE id = \$1 FOR UPDATE/);
  const campLock = at(/SELECT \* FROM recruit_campaigns WHERE id = \$1 AND archived_at IS NULL FOR UPDATE/);
  assert.ok(L1 < woLock && woLock < campLock, '잠금 순서 = L1 → 오더 행 → 공고 행(결정 262 완화 금지)');
  const firstWrite = at(/UPDATE work_orders SET \$\{sets\.join/);
  for (const code of ['field_not_editable', 'field_conflict', 'edit_base_missing', 'bidir_not_on', 'link_changed_retry']) {
    const i = fn.indexOf(`code: '${code}'`);
    assert.ok(i > 0 && i < firstWrite, `${code} 는 쓰기 전에 끝난다(부분 반영 금지)`);
  }
  assert.ok(fn.indexOf("code: 'campaign_rejected'") > firstWrite && /return await _abort\(client, 409, \{ ok: false, code: 'campaign_rejected'/.test(fn), '공고가 거부하면 오더 쓰기까지 되돌린다');
  assert.ok(/WHERE id = \$1 AND sync_version = \$\{add\(curVersion\)\}/.test(fn), '버전 조건부 쓰기');
  assert.ok(/BIDIR_HARD_OFF/.test(fn.slice(0, 300)), '비상 스위치는 맨 앞');
  const ord = read('routes/order.routes.js');
  assert.ok(/if \(current\.bidir_state === 'on'\) \{\s*const sw = await readBidirSwitch\(pool\);\s*if \(sw\.in2rw === 'apply'\)/.test(ord), '연결된 오더 + apply 일 때만 새 경로');
  const branchAt = ord.indexOf("if (current.bidir_state === 'on') {");
  assert.ok(branchAt > 0 && branchAt < ord.indexOf('const sourceEditLocked = isSourceEditLocked(current);'), '잠금 판정보다 먼저 갈라진다');
  assert.ok(/if \(!baseVersion\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, code: 'edit_base_required'/.test(ord), '기준 버전 없이 저장하지 않는다');
  assert.ok(/o\.bidir_state === 'on' && \(await readBidirSwitch\(pool\)\)\.in2rw === 'apply'/.test(ord), '관리자 수정도 같은 조건');
  // 겹친 칸 = 나중 저장 값은 인트라넷발 원본 수정에만(사용자 확정 2026-10-20) — 관리자 수정은 기본(block)
  const bidirFn = ord.slice(ord.indexOf('async function _intakeSourceBidir('), ord.indexOf('async function _observeSourceBidir('));
  assert.ok(/conflictPolicy: 'last_writer'/.test(bidirFn), '인트라넷발 = 나중 저장 값');
  assert.equal((ord.match(/conflictPolicy:/g) || []).length, 1, '다른 호출(관리자 수정)은 정책을 주지 않는다');
  assert.ok(/const lastWriter = p\.conflictPolicy === 'last_writer';/.test(fn) && /plan\.readOnly\.length\) \{\s*return await _abort\(client, 409, \{ ok: false, code: 'field_conflict'/.test(fn), '보기전용은 정책과 무관하게 막는다');
  console.log('sharedPatchService: static passed');
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
  const sid = 'ro_bidir_' + stamp;
  const camp = 'camp_bidir_' + stamp;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const payload = (rev, key, extra = {}) => ({
    source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: rev, idempotency_key: key,
    title: '가짜 양방향 오더', recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
    review_guide: '[리뷰등록 가이드]\n사진 3장 올려주세요', special_notes: '주의 사항 없음',
    product_url: 'https://www.coupang.com/vp/products/1', inflow_type: 'link', purchase_channel: '쿠팡',
    delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE', ...extra });
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
  const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
  const put = async (rev, key, extra, bidir) => call('PUT', `/api/order/intake/source/${sid}`, { ...payload(rev, key, extra), ...(bidir ? { bidir } : {}) });
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    // ── 준비: 인트라넷이 보낸 오더 + 그 오더로 발행한 것과 같은 공고 ──
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

    // ── 연결: 같으면 on + 스냅숏 ──
    const dry = await linkSharedOrder({ workOrderId: w.id, dryRun: true });
    assert.equal(dry.body.state, 'on', '발행 그대로인 공고 = 같음: ' + JSON.stringify(dry.body.diffs));
    assert.equal((await wo()).bidir_state, 'off', 'dry 는 쓰지 않는다');
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on');
    const v0 = Number(ln.body.sync_version);
    assert.ok(v0 > 1e15, 'HLC 버전(µs)');
    assert.equal((await pool.query('SELECT count(*)::int n FROM work_order_shared_snapshots WHERE work_order_id=$1 AND sync_version=$2', [w.id, v0])).rows[0].n, 1);

    // ── 스위치 off: 연결돼 있어도 종전 경로(오늘 동작) ──
    await setSwitch('{"in2rw":"off"}');
    const legacy = await put(2, `${sid}:2:b`, { special_notes: '종전 경로로 고침' });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(Number((await wo()).sync_version), v0, 'off 에서는 버전이 안 바뀐다(공유 저장을 안 탄다)');
    await pool.query(`UPDATE work_orders SET special_notes = '주의 사항 없음' WHERE id = $1`, [w.id]);   // 시험용 원상복구(스냅숏과 맞춤)

    await setSwitch('{"in2rw":"apply"}');
    // ── 기준 버전 없이 → 409(덮어쓰기 금지) ──
    const noBase = await put(3, `${sid}:3:c`, { review_guide: '기준 없이' });
    assert.equal(noBase.body.code, 'edit_base_required', JSON.stringify(noBase.body));

    // ── 글 칸 수정 → 오더·공고 함께 · 버전 · 스냅숏 · 인트라넷이 받은 버전 ──
    const sh = await call('GET', `/api/order/intake/source/${sid}/shared`);
    assert.equal(sh.status, 200); assert.equal(sh.body.bidir_active, true); assert.equal(sh.body.sync_version, v0);
    const e1 = await put(3, `${sid}:3:d`, { review_guide: '[리뷰등록 가이드]\n사진 5장으로 바뀜', purchase_time: '14:00 ~ 17:00', purchase_channel: '네이버',
      product_url: 'https://smartstore.naver.com/x/products/2' }, { base_sync_version: v0, op_id: 'op_' + stamp + '_1' });
    assert.equal(e1.status, 200, JSON.stringify(e1.body));
    w = await wo();
    const v1 = Number(w.sync_version);
    assert.ok(v1 > v0); assert.equal(Number(w.intranet_acked_version), v1, '인트라넷발 저장 = 인트라넷이 그 버전을 안다');
    assert.equal(Number(w.source_revision), 3);
    let c = await cRow();
    assert.equal(c.work_detail.reviewGuide, '사진 5장으로 바뀜', '리뷰가이드가 공고까지(리뷰어 화면)');
    assert.equal(c.time_range, '14:00 ~ 17:00'); assert.equal(String(c.window_start).slice(0, 5), '14:00', '시간창도 함께');
    assert.equal(c.channel, '네이버'); assert.equal(c.landing_url, 'https://smartstore.naver.com/x/products/2');
    assert.equal((await pool.query('SELECT count(*)::int n FROM work_order_shared_snapshots WHERE work_order_id=$1', [w.id])).rows[0].n, 2);
    // 같은 저장 재전송(번호·키 같음) = 멱등
    const again = await put(3, `${sid}:3:d`, { review_guide: '[리뷰등록 가이드]\n사진 5장으로 바뀜', purchase_time: '14:00 ~ 17:00', purchase_channel: '네이버',
      product_url: 'https://smartstore.naver.com/x/products/2' }, { base_sync_version: v0, op_id: 'op_' + stamp + '_1' });
    assert.equal(again.body.idempotent, true, JSON.stringify(again.body));
    assert.equal(Number((await wo()).sync_version), v1);

    // ── 그 사이 리뷰웹(관리자)이 특이사항을 고침 → 인트라넷이 옛 기준으로 같은 칸을 다르게 저장 ──
    //    = 나중에 저장한 값이 남고, 덮인 리뷰웹 값을 응답으로 돌려준다(사용자 확정 2026-10-20 · 인트라넷발만)
    const adm = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '리뷰웹에서 고친 특이사항' }, baseVersion: v1, origin: 'rw_admin', actor: '관리자' });
    assert.equal(adm.status, 200, JSON.stringify(adm.body));
    const v2 = Number(adm.body.sync_version);
    assert.ok(v2 > v1);
    assert.deepEqual(adm.body.overwritten, [], '겹친 칸이 없으면 빈 목록');
    assert.equal((await pool.query('SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id=$1 AND sync_version=$2', [w.id, v2])).rows[0].n, 1, '리뷰웹발 = 인트라넷으로 보낼 대기열');
    // 정책을 안 준 저장(기본 block — 관리자·연결)은 여전히 충돌이면 쓰기 0
    const blk = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '기본 정책 시험' }, baseVersion: v1, origin: 'intranet', actor: '시험' });
    assert.equal(blk.status, 409); assert.equal(blk.body.code, 'field_conflict', JSON.stringify(blk.body));
    assert.deepEqual(blk.body.conflicts.map(x => x.path), ['f:special_notes']);
    assert.equal((await wo()).special_notes, '리뷰웹에서 고친 특이사항', '기본 정책 충돌 = 쓰기 0');
    const keep = { review_guide: '[리뷰등록 가이드]\n사진 5장으로 바뀜', purchase_time: '14:00 ~ 17:00', purchase_channel: '네이버', product_url: 'https://smartstore.naver.com/x/products/2' };
    const cf = await put(4, `${sid}:4:e`, { ...keep, special_notes: '인트라넷에서 고친 특이사항' }, { base_sync_version: v1 });
    assert.equal(cf.status, 200, JSON.stringify(cf.body));
    assert.equal(cf.body.overwritten.length, 1, JSON.stringify(cf.body.overwritten));
    const ow = cf.body.overwritten[0];
    assert.equal(ow.path, 'f:special_notes');
    assert.equal(ow.before, '리뷰웹에서 고친 특이사항', '덮인 리뷰웹 값');
    assert.equal(ow.after, '인트라넷에서 고친 특이사항', '남은 값');
    assert.ok(ow.label && !/^f:/.test(ow.label), '사람이 읽는 칸 이름: ' + ow.label);
    w = await wo();
    assert.equal(w.special_notes, '인트라넷에서 고친 특이사항', '나중에 저장한 값이 남는다');
    assert.equal((await cRow()).work_detail.specialNotes, '인트라넷에서 고친 특이사항', '공고(리뷰어 화면)까지');
    assert.equal(Number(w.source_revision), 4);
    const v3 = Number(w.sync_version);
    assert.ok(v3 > v2);
    assert.equal((await pool.query(`SELECT state->>'special_notes' s FROM work_order_shared_snapshots WHERE work_order_id=$1 AND sync_version=$2`, [w.id, v2])).rows[0].s,
      '리뷰웹에서 고친 특이사항', '덮인 값은 이력(스냅숏)에 남는다');
    // 다른 칸만 고친 것은 겹침이 아니다(3방향) — 리뷰웹이 특이사항을 또 고친 뒤, 인트라넷은 리뷰가이드만 바꿈
    const adm2 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(w), special_notes: '리뷰웹 두 번째 수정' }, baseVersion: v3, origin: 'rw_admin', actor: '관리자' });
    assert.equal(adm2.status, 200, JSON.stringify(adm2.body));
    const nc = await put(5, `${sid}:5:f`, { ...keep, special_notes: '인트라넷에서 고친 특이사항', review_guide: '[리뷰등록 가이드]\n사진 7장' }, { base_sync_version: v3 });
    assert.equal(nc.status, 200, JSON.stringify(nc.body));
    assert.deepEqual(nc.body.overwritten, [], '손대지 않은 칸은 덮지 않고 알림도 없다');
    w = await wo();
    assert.equal(w.special_notes, '리뷰웹 두 번째 수정', '안 고친 칸은 리뷰웹 값이 남는다');
    assert.equal(w.review_guide, '[리뷰등록 가이드]\n사진 7장');
    const v4 = Number(w.sync_version);
    const k2 = { ...keep, review_guide: '[리뷰등록 가이드]\n사진 7장', special_notes: '리뷰웹 두 번째 수정' };

    // ── 인원을 모르는 옛 인트라넷 창(bidir.counts 없음)의 모집인원 → 받지 않는다(7단계-② 배포 순서 장치), 쓰기 0 · 인트라넷이 다시 받아 간다 ──
    const ne = await put(6, `${sid}:6:h`, { ...k2, recruit_count: 20 }, { base_sync_version: v4 });
    assert.equal(ne.status, 200, JSON.stringify(ne.body)); assert.deepEqual(ne.body.applied, [], JSON.stringify(ne.body));
    assert.equal(ne.body.push_back, true, '보낸 인원이 저장과 달라 인트라넷 사본을 다시 맞춘다');
    assert.equal(Number((await wo()).recruit_count), 10);

    // ── 공고가 거부(읽지 못한 구매시간) → 오더까지 되돌림 ──
    const rj = await put(7, `${sid}:7:i`, { ...k2, purchase_time: '아무때나 말고 적당히' }, { base_sync_version: v4 });
    assert.equal(rj.body.code, 'campaign_rejected', JSON.stringify(rj.body));
    assert.ok(/구매시간대/.test(rj.body.error));
    w = await wo();
    assert.equal(w.purchase_time, '14:00 ~ 17:00', '오더도 안 바뀐다');
    assert.equal(Number(w.sync_version), v4);
    // 가이드 없는 가이드유입 → 거부
    const gm = await put(7, `${sid}:7:j`, { ...k2, inflow_type: 'guide', inflow_guide: '' }, { base_sync_version: v4 });
    assert.equal(gm.body.code, 'campaign_rejected', JSON.stringify(gm.body));
    assert.equal((await wo()).inflow_type, 'link');

    // ── 관리자 수정 라우트: 고유 칸 막힘 · 글 칸 반영 ──
    const jwt = require('jsonwebtoken');
    const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
    const ae = async (body) => call('PUT', '/api/order/admin/edit', body, { authorization: 'Bearer ' + tok });
    const own = await ae({ id: w.id, title: '리뷰웹에서 바꾼 작업명' });
    if (own.status !== 401 && own.status !== 403) {
      assert.equal(own.body.code, 'intranet_owned', JSON.stringify(own.body));
      // ★ 7단계 🔴3: 작업표 칸도 공유 칸 — 공유 저장으로 가서 아직 안 연 칸(리뷰타입 = 7단계-④ 구조)이면 409 · 쓰기 0(종전: 버전 없이 그대로 써졌다)
      //   (총모집은 7단계-② 에서 열렸다 — 여기서는 아직 안 연 칸으로 막힘을 본다)
      const vBefore = Number((await wo()).sync_version);
      const mix = await ae({ id: w.id, review_guide: '관리자 리뷰가이드', review_type: '텍스트' });
      assert.equal(mix.body.code, 'field_not_editable', JSON.stringify(mix.body));
      const rcOnly = await ae({ id: w.id, review_type: '텍스트' });
      assert.equal(rcOnly.body.code, 'field_not_editable', JSON.stringify(rcOnly.body));
      assert.equal((await wo()).review_type, '포토', '쓰기 0'); assert.equal((await wo()).review_guide !== '관리자 리뷰가이드', true, '같이 보낸 글 칸도 쓰기 0');
      assert.equal(Number((await wo()).sync_version), vBefore);
      const der = await ae({ id: w.id, courier_proxy: true });
      assert.equal(der.body.code, 'derived_field', JSON.stringify(der.body));
      const okE = await ae({ id: w.id, review_guide: '[리뷰등록 가이드]\n관리자가 고친 가이드' });
      assert.equal(okE.status, 200, JSON.stringify(okE.body));
      assert.ok(Number((await wo()).sync_version) > v4, '관리자 글 칸 수정도 버전이 오른다');
      assert.equal((await cRow()).work_detail.reviewGuide, '관리자가 고친 가이드');
    } else {
      console.log('  - 관리자 수정 라우트: 시험 토큰이 거부돼 건너뜀(' + own.status + ')');
    }

    // ── 마감 공고는 연결하지 않는다 ──
    const arch = await linkSharedOrder({ workOrderId: w.id, dryRun: true });
    assert.equal(arch.body.already, true);
    await pool.query(`UPDATE work_orders SET bidir_state = 'off' WHERE id = $1`, [w.id]);
    await pool.query(`UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1`, [camp]);
    assert.equal((await linkSharedOrder({ workOrderId: w.id })).body.code, 'campaign_archived');
    await pool.query(`UPDATE recruit_campaigns SET archived_at = NULL WHERE id = $1`, [camp]);
    await pool.query(`UPDATE work_orders SET bidir_state = 'on' WHERE id = $1`, [w.id]);

    // ── 동시 저장 반복: 인트라넷(리뷰가이드) × 관리자(특이사항) 40회 — 교착 0 · 공고 행 쥐는 시간 ──
    let deadlocks = 0, busy = 0, ok = 0, conflicts = 0;
    const holds = [];
    let rev = Number((await wo()).source_revision);
    for (let i = 0; i < 40; i++) {
      const cur = await wo();
      const base = Number(cur.sync_version);
      const t0 = Date.now();
      const [a, b] = await Promise.allSettled([
        put(rev + 1, `${sid}:${rev + 1}:x${i}`, { ...k2, review_guide: cur.review_guide + ' ' + i, special_notes: cur.special_notes }, { base_sync_version: base }),
        applySharedPatch({ workOrderId: cur.id, mine: { ...readSharedState(cur), special_notes: '관리자 ' + i }, baseVersion: base, origin: 'rw_admin', actor: '관리자' }),
      ]);
      holds.push(Date.now() - t0);
      for (const r of [a, b]) {
        if (r.status === 'rejected') { if (r.reason && r.reason.code === '40P01') deadlocks++; else throw r.reason; continue; }
        const body = r.value.body;
        if (r.value.status === 200) ok++;
        else if (body.code === 'busy_retry') busy++;
        else if (['version_race', 'field_conflict', 'revision_race', 'revision_already_applied'].includes(body.code)) conflicts++;
        else throw new Error('예상 밖 응답: ' + JSON.stringify(body));
      }
      rev = Number((await wo()).source_revision);
    }
    holds.sort((x, y) => x - y);
    const p95 = holds[Math.floor(holds.length * 0.95)];
    assert.equal(deadlocks, 0, '교착 0');
    assert.ok(ok >= 40, `대부분 반영(${ok} ok · ${conflicts} 경합 · ${busy} 바쁨)`);
    // 스냅숏은 버전마다 하나 · 버전은 증가만
    const snaps = (await pool.query('SELECT sync_version FROM work_order_shared_snapshots WHERE work_order_id=$1 ORDER BY sync_version', [w.id])).rows.map(r => Number(r.sync_version));
    assert.equal(new Set(snaps).size, snaps.length);
    assert.equal(snaps[snaps.length - 1], Number((await wo()).sync_version), '마지막 스냅숏 = 현재 버전');
    console.log(`sharedPatchService: PG passed (동시 ${ok} ok · ${conflicts} 경합 · ${busy} 바쁨 · 교착 0 · 두 저장 묶음 p95 ${p95}ms)`);
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
  console.log('sharedPatchService: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
