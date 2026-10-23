/**
 * 양방향 4단계-2(결정 274) — 모집공고 편집 창 저장(PUT /api/campaign/admin/:id)의 공유 글 칸.
 *   A. 정적 — UPDATE 직전에 공유 저장 · 연결 공고면 공유 칸 매개변수 비움 · work_detail 공유 하위 칸 DB 값 유지 ·
 *              리뷰어앱 스코프 편집 막음 · 상세 응답에 기준 버전 · 화면이 기준을 보내고 알림을 그린다
 *   B. PGTEST_URL 있으면 진짜 PG + 실제 라우트:
 *      상세 = 기준 버전 · 리뷰가이드 수정 → 오더(구간만)·공고·인트라넷 보낼 줄 · 창을 연 뒤 인트라넷이 고친 특이사항은 안 되돌림 ·
 *      같은 칸 겹침 = 나중 저장 값 + 덮인 값 · 옛 화면(기준 없음): 공유 칸이 다르면 409 쓰기 0 / 같으면 다른 칸 저장 ·
 *      되돌릴 수 없는 칸(썸네일 지우기) = 409 쓰기 0 · 스위치 off = 종전 저장 · 리뷰어앱 스코프 편집 = 공유 칸 409 ·
 *      옵션 URL: 창을 연 뒤 바뀐 값을 손대지 않은 화면 값으로 안 되돌림
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── A. 정적 ──
{
  const r = read('src/routes/campaign.routes.js');
  const put = r.slice(r.indexOf("router.put('/admin/:id', authMiddleware"), r.indexOf("router.delete('/admin/:id'"));
  const callAt = put.indexOf('.applyCampaignSharedSave({ campaignId: id, body: req.body');
  const updAt = put.indexOf('`UPDATE recruit_campaigns SET\n        title = COALESCE($2, title),');
  assert.ok(callAt > 0 && updAt > callAt, 'UPDATE 직전에 공유 저장');
  assert.ok(put.indexOf('assertCampaignRecruitTotal(') < callAt, '검증이 모두 끝난 뒤(공유 저장은 따로 커밋된다)');
  assert.match(put, /if \(bidirEdit\.response\) return res\.status\(bidirEdit\.response\.status\)\.json\(bidirEdit\.response\.body\);/);
  assert.match(put, /title, _bx \? null : channel, _bx \? null : channel_custom, manager, _bx \? null : time_range,/);
  assert.match(put, /_bx \? null : \(thumbnail_url \?\? null\),\s*_bxLanding \? null : \(landing_url \?\? null\),/);
  assert.match(put, /\(_bxWin \|\| _wsEff === undefined/); assert.match(put, /\(_bxWin \|\| _weEff === undefined/);
  assert.match(put, /WHEN \$52::boolean AND \$30::jsonb IS NULL THEN work_detail\s*WHEN \$52::boolean\s*THEN \$30::jsonb \|\| COALESCE\(\(SELECT jsonb_object_agg\(k, work_detail->k\)/, '연결 공고: null 이면 통째 유지, 아니면 공유 하위 칸 DB 값');
  assert.match(put, /WHEN \$53::text IS NOT NULL AND COALESCE\(time_range, ''\) <> \$53::text THEN window_start/, '시각은 그 사이 글자가 그대로일 때만');
  assert.match(put, /_bx,\s*\/\/ \$52/);
  const svc = read('src/services/campaignSharedSave.service.js');
  const svcKeys = svc.match(/WD_SHARED_KEYS = Object\.freeze\(\[([^\]]+)\]/)[1].replace(/[\s']/g, '');
  // ★ 5단계: 목록 뒤에 조건부 productLines($54)가 붙어 닫는 괄호가 뒤로 갔다 — 목록 자체 비교는 그대로(검사 의미 불변).
  const sqlKeys = put.match(/unnest\(ARRAY\[([^\]]+)\]/)[1].replace(/[\s']/g, '');
  assert.equal(sqlKeys, svcKeys, 'SQL 공유 하위 칸 목록 = 서비스 목록');
  assert.match(put, /\|\| CASE WHEN \$54::boolean THEN ARRAY\['productLines'\] ELSE ARRAY\[\]::text\[\] END\) AS k/, '상품 안내 글은 리뷰오더에서 금액이 바뀐 경우에만 DB 값 유지');
  assert.match(put, /_bx && bidirEdit\.keepProductLines === true,\s*\/\/ \$54/);
  assert.match(put, /delivery_type, _bx \? null : \(review_fee \|\| 0\),/, '연결 공고의 리뷰비는 공유 저장이 쓴다');
  assert.match(put, /const normFees = _bx \? null : normalizeFeeSchedules\(fee_schedules\);/, '연결 공고는 기간표를 다시 쓰지 않는다');
  assert.match(svc, /if \(sw\.campaign_edit !== 'on'\) return \{ active: false \};/, '스위치 off = 종전 저장');
  const sc = r.slice(r.indexOf('async function _scopedCampaignEdit('), r.indexOf('async function _scopedCampaignEdit(') + 9000);
  assert.ok(sc.indexOf('scopedEditSharedBlock(') > 0 && sc.indexOf('scopedEditSharedBlock(') < sc.indexOf('UPDATE recruit_campaigns'), '리뷰어앱 스코프 편집도 공유 칸을 막는다');
  assert.match(r, /if \(link\) bidir = \{ linked: true, sync_version: Number\(link\.wo\.sync_version\) \|\| 0/, '상세 = 기준 버전');
  const ui = read('../frontend/js/index-recruit.js');
  assert.match(ui, /window\._rfBidirBase = \(json && json\.bidir && Number\(json\.bidir\.sync_version\) > 0\)/);
  assert.match(ui, /if \(_recruitEditId && window\._rfBidirBase\) payload\.bidir_base_sync_version = window\._rfBidirBase;/);
  assert.ok(ui.indexOf('payload.bidir_base_sync_version = window._rfBidirBase') < ui.indexOf('res = await fetch(_campApi(`/${_recruitEditId}`)'), '보내기 전에 싣는다');
  assert.match(ui, /if \(saved && saved\.shared\) _changed\.unshift\(\.\.\._rfSharedNoticeLines\(saved\.shared\)\);/, '덮인 값 알림');
  assert.ok(ui.indexOf('_changed.unshift(..._rfSharedNoticeLines(saved.shared))') > ui.lastIndexOf('_changed.unshift("✅ 모집을 다시 열었습니다'), '다른 안내를 다 넣은 뒤 맨 위로(3줄 상자에서 안 숨게)');
  assert.match(ui, /errData && errData\.shared \? _rfSharedNoticeLines\(errData\.shared\)/, '나머지 저장이 실패해도 덮인 값 안내');
  assert.match(put, /if \(req\._bidirShared\) \{[\s\S]{0,300}shared: req\._bidirShared \}\);/, '실패 응답에도 공유 저장 결과');
  assert.match(ui, /window\._rfBidirBase = null;/, '다른 공고 열 때 지운다');
  const sp = read('src/services/sharedPatch.service.js');
  // ★ 5단계: 금액 칸(리뷰비)이 더해졌다 — 공고 창발은 여전히 인트라넷 고유 칸을 못 쓴다(검사 의미 불변 · 강화).
  // ★ 7단계-②: 인원 칸(총모집·일건수·혼합 수량)이 더해졌다 — 인트라넷 고유 칸 제외는 그대로(아래)
  // 7단계-③(2026-10-21): 주말 제외(PHASE7W)가 더해졌다 — 공고 창 쓰기 칸 = 공유 칸 묶음(인트라넷 고유 칸 없음)이라는 뜻은 그대로
  // 7단계-④ ⑤(2026-10-21): 배송 한 종류(PHASE7D)가 더해졌다 — 검사 의미 불변(공고 창발 = 공유 칸만)
  assert.match(sp, /campaign: new Set\(\[\.\.\.PHASE3_SHARED_FIELDS, \.\.\.PHASE5_SHARED_FIELDS, \.\.\.PHASE7Q_SHARED_FIELDS, \.\.\.PHASE7W_SHARED_FIELDS, STRUCTURE_FIELD, RENAME_FIELD, MODE_FIELD, \.\.\.PHASE7R_SHARED_FIELDS, \.\.\.PHASE7D_SHARED_FIELDS\]\)/);   // 7단계-④ ⑤-3 MODE_FIELD 더함(검사 의미 불변 — 공고 창 쓰기 칸 목록 고정)
  assert.doesNotMatch(sp.match(/\n  campaign: new Set\([^\n]*/)[0], /INTRANET_EDITABLE_AFTER_ACCEPT/, '공고 창발에 인트라넷 고유 칸 없음');
  assert.match(sp, /const PHASE5_SHARED_FIELDS = Object\.freeze\(\['review_fee'\]\);/);
  console.log('campaignSharedSave: static passed');
}

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder, applySharedPatch, readSharedState } = require('../src/services/sharedPatch.service');
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const sid = 'ro_cedit_' + stamp;
  const camp = 'camp_cedit_' + stamp;
  const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
  const scoped = jwt.sign({ id: 'rv_t', role: 'admin', name: '리뷰어관리자', via: 'reviewer_campaign', ia: true, iu: 'u1' }, process.env.JWT_SECRET);
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const admin = { authorization: 'Bearer ' + tok };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
  const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
  const pendingPush = async () => (await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1 AND status = 'pending'`, [(await wo()).id])).rows[0].n;
  /** 편집 창이 여는 것 → 저장 본문(종전 화면처럼 전 칸을 다시 보낸다). */
  const openEditor = async () => {
    const d = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const c = d.body.data;
    const body = {
      title: c.title, review_fee: c.review_fee, max_slots: c.max_slots, sort_order: c.sort_order, deadline: c.deadline,
      work_detail: { ...c.work_detail }, thumbnail_url: c.thumbnail_url, time_range: c.time_range, landing_url: c.landing_url,
      channel: c.channel, channel_custom: c.channel_custom || '',
      window_start: String(c.window_start || '').slice(0, 5), window_end: String(c.window_end || '').slice(0, 5),
    };
    if (d.body.bidir) body.bidir_base_sync_version = d.body.bidir.sync_version;
    return { body, bidir: d.body.bidir || null };
  };
  const save = (body, headers = admin) => call('PUT', `/api/campaign/admin/${camp}`, body, headers);
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  try {
    const c1 = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 공고편집 오더', recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장 올려주세요\n\n[기타 안내]\n문의는 채팅방', special_notes: '주의 사항 없음',
      product_url: 'https://www.coupang.com/vp/products/1', inflow_type: 'link', purchase_channel: '쿠팡', thumbnail_url: 'https://x/thumb1.jpg',
      delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: JSON.stringify([{ name: '가짜 상품', url: 'https://www.coupang.com/vp/products/1', option_schema_version: 2, product_mode: 'none',
        base: { pay: 12000, count: 10, daily: 5, review_type_mix: [] }, options: [] }]) });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    let w = await wo();
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, $12, TRUE, 'active', $13::jsonb)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: '상품 줄' })]);
    for (const o of proj.options) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    // ── 상세 = 기준 버전 · 손대지 않고 저장(제목만) = 오더 그대로 ──
    let ed = await openEditor();
    assert.equal(ed.bidir.sync_version, Number(ln.body.sync_version), '상세가 기준 버전을 준다');
    let r = await save({ ...ed.body, title: '제목만 바꿈' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.shared, undefined, '공유 칸을 안 고쳤으면 공유 저장 없음');
    assert.equal((await cRow()).title, '제목만 바꿈');
    assert.equal(Number((await wo()).sync_version), Number(ln.body.sync_version), '오더 버전 그대로');

    // ── 리뷰가이드·특이사항 수정 → 오더(가이드 구간만)·공고·인트라넷 보낼 줄 ──
    ed = await openEditor();
    r = await save({ ...ed.body, work_detail: { ...ed.body.work_detail, reviewGuide: '사진 5장 + 50자', specialNotes: '박스 사진 필수' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shared.changed.sort(), ['리뷰가이드', '특이사항']);
    assert.deepEqual(r.body.shared.overwritten, []);
    w = await wo();
    assert.equal(w.review_guide, '[리뷰등록 가이드]\n사진 5장 + 50자\n\n[기타 안내]\n문의는 채팅방', '가이드 구간만 바뀐다');
    assert.equal(w.special_notes, '박스 사진 필수');
    let c = await cRow();
    assert.equal(c.work_detail.reviewGuide, '사진 5장 + 50자'); assert.equal(c.work_detail.specialNotes, '박스 사진 필수');
    assert.equal(c.work_detail.productLines, '상품 줄', '공고 전용 work_detail 칸은 그대로');
    assert.equal(await pendingPush(), 1, '인트라넷으로 보낼 줄');
    const snapOrigin = (await pool.query('SELECT origin FROM work_order_shared_snapshots WHERE work_order_id=$1 ORDER BY sync_version DESC LIMIT 1', [w.id])).rows[0].origin;
    assert.equal(snapOrigin, 'campaign');

    // ── 창을 연 뒤 인트라넷이 특이사항을 고침 → 창은 옛 특이사항 그대로 + 리뷰가이드만 고쳐 저장 → 특이사항 안 되돌림 ──
    ed = await openEditor();
    const i1 = await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '인트라넷이 고친 특이사항' }, baseVersion: Number(w.sync_version), origin: 'intranet', actor: '인트라넷', conflictPolicy: 'last_writer' });
    assert.equal(i1.status, 200, JSON.stringify(i1.body));
    r = await save({ ...ed.body, work_detail: { ...ed.body.work_detail, reviewGuide: '사진 7장' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shared.overwritten, []);
    w = await wo(); c = await cRow();
    assert.equal(w.special_notes, '인트라넷이 고친 특이사항', '손대지 않은 칸은 인트라넷 값(옛 화면 값으로 안 되돌림)');
    assert.equal(c.work_detail.specialNotes, '인트라넷이 고친 특이사항', '공고도(work_detail 통째 저장이 되돌리지 않음)');
    assert.equal(c.work_detail.reviewGuide, '사진 7장');

    // ── 같은 칸 겹침 = 나중 저장 값 + 덮인 값 ──
    ed = await openEditor();
    await applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(await wo()), special_notes: '인트라넷 두 번째' }, baseVersion: Number(w.sync_version), origin: 'intranet', actor: '인트라넷', conflictPolicy: 'last_writer' });
    r = await save({ ...ed.body, work_detail: { ...ed.body.work_detail, specialNotes: '공고 창에서 마지막으로 고침' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.shared.overwritten.length, 1);
    assert.equal(r.body.shared.overwritten[0].before, '인트라넷 두 번째');
    assert.equal((await wo()).special_notes, '공고 창에서 마지막으로 고침');
    assert.equal((await cRow()).work_detail.specialNotes, '공고 창에서 마지막으로 고침');

    // ── 구매시간·채널·썸네일·랜딩 ──
    ed = await openEditor();
    r = await save({ ...ed.body, time_range: '14:00 ~ 17:00', window_start: '14:00', window_end: '17:00', channel: '직접입력', channel_custom: '자사몰',
      thumbnail_url: 'https://x/thumb2.jpg', landing_url: 'https://www.coupang.com/vp/products/2' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    w = await wo(); c = await cRow();
    assert.equal(w.purchase_time, '14:00 ~ 17:00'); assert.equal(String(c.window_start).slice(0, 5), '14:00'); assert.equal(c.time_range, '14:00 ~ 17:00');
    assert.equal(w.purchase_channel, '자사몰'); assert.equal(w.purchase_channel_custom, true); assert.equal(c.channel, '직접입력'); assert.equal(c.channel_custom, '자사몰');
    assert.equal(w.thumbnail_url, 'https://x/thumb2.jpg'); assert.equal(c.thumbnail_url, 'https://x/thumb2.jpg');
    assert.equal(w.product_url, 'https://www.coupang.com/vp/products/2'); assert.equal(c.landing_url, 'https://www.coupang.com/vp/products/2');

    // ── 창을 연 뒤 인트라넷이 구매시간을 바꿈 → 손대지 않은 창 저장: 막히지 않고, 옛 시각으로 되돌리지 않는다 ──
    ed = await openEditor();
    const iT = await applySharedPatch({ workOrderId: (await wo()).id, mine: { ...readSharedState(await wo()), purchase_time: '15:00 ~ 19:00' }, baseVersion: Number((await wo()).sync_version), origin: 'intranet', actor: '인트라넷', conflictPolicy: 'last_writer' });
    assert.equal(iT.status, 200, JSON.stringify(iT.body));
    r = await save({ ...ed.body, title: '시간 경합 뒤 제목' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    c = await cRow();
    assert.equal(c.time_range, '15:00 ~ 19:00'); assert.equal(String(c.window_start).slice(0, 5), '15:00', '옛 화면 시각(14:00)으로 안 되돌림');
    assert.equal(c.title, '시간 경합 뒤 제목');
    // 옛 공통 유입가이드(work_detail.inflowGuideHtml)도 공유 하위 칸으로 지킨다
    await pool.query(`UPDATE recruit_campaigns SET work_detail = work_detail || '{"inflowGuideHtml":"<p>인트라넷 유입가이드</p>"}'::jsonb WHERE id = $1`, [camp]);
    ed = await openEditor();
    r = await save({ ...ed.body, title: '유입가이드 보호', work_detail: { ...ed.body.work_detail, inflowGuideHtml: '<p>옛 화면 값</p>' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cRow()).work_detail.inflowGuideHtml, '<p>인트라넷 유입가이드</p>', '연결 공고의 공통 유입가이드는 편집 저장이 덮지 않는다');

    // ── 되돌릴 수 없는 칸 = 409 쓰기 0(제목도 저장 안 됨) ──
    ed = await openEditor();
    const v = Number((await wo()).sync_version);
    r = await save({ ...ed.body, title: '저장되면 안 됨', thumbnail_url: '' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'campaign_field_unmappable', JSON.stringify(r.body));
    assert.notEqual((await cRow()).title, '저장되면 안 됨'); assert.equal(Number((await wo()).sync_version), v);

    // ── 옛 화면(기준 없음): 공유 칸이 다르면 409 쓰기 0 · 같으면 다른 칸 저장 ──
    ed = await openEditor();
    const old = { ...ed.body }; delete old.bidir_base_sync_version;
    r = await save({ ...old, title: '옛 화면', work_detail: { ...old.work_detail, specialNotes: '옛 화면이 바꾼 값' } });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'stale_editor', JSON.stringify(r.body));
    assert.notEqual((await cRow()).title, '옛 화면');
    r = await save({ ...old, title: '옛 화면 제목만' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cRow()).title, '옛 화면 제목만');
    assert.equal((await wo()).special_notes, '공고 창에서 마지막으로 고침');

    // ── 옵션 URL: 창을 연 뒤 바뀐 값을 손대지 않은 화면 값으로 안 되돌림 ──
    {
      const { protectOptionLeaves, findBidirLink } = require('../src/services/campaignSharedSave.service');
      const link = await findBidirLink(pool, camp);
      const baseV = Number(link.wo.sync_version);
      const baseProj = projectOrderToCampaign((await pool.query('SELECT state FROM work_order_shared_snapshots WHERE work_order_id=$1 AND sync_version=$2', [link.wo.id, baseV])).rows[0].state).options;
      if (baseProj.length) {
        const o0 = baseProj[0];
        const [pName, oKey] = o0.key.split('|');
        await pool.query(`UPDATE campaign_options SET option_url = 'https://changed.example/after-open' WHERE campaign_id = $1`, [camp]);
        const normOpts = [{ productName: pName, optKey: oKey || pName, unitKind: o0.unit_kind, optionUrl: o0.option_url, inflowGuideHtml: o0.inflow_guide_html || '', inflowGuideImages: [] }];
        const kept = await protectOptionLeaves({ normOpts, link: await findBidirLink(pool, camp), baseVersion: baseV });
        assert.equal(normOpts[0].optionUrl, 'https://changed.example/after-open', '손대지 않은 옵션 URL = 지금 값 유지: ' + JSON.stringify(kept));
        const mine = [{ productName: pName, optKey: oKey || pName, unitKind: o0.unit_kind, optionUrl: 'https://admin.example/edited', inflowGuideHtml: o0.inflow_guide_html || '', inflowGuideImages: [] }];
        await protectOptionLeaves({ normOpts: mine, link: await findBidirLink(pool, camp), baseVersion: baseV });
        assert.equal(mine[0].optionUrl, 'https://admin.example/edited', '관리자가 고친 값은 그대로');
      } else assert.fail('옵션 보호 시험이 빈 시험이 되면 안 된다(투영 옵션 없음)');
    }

    // ── 리뷰어앱 스코프 편집: 공유 칸 변경 409 · 같으면 통과 ──
    const sc = await save({ thumbnail_url: 'https://x/scoped.jpg' }, { authorization: 'Bearer ' + scoped });
    assert.equal(sc.status, 409); assert.equal(sc.body.code, 'shared_field_scoped', JSON.stringify(sc.body));
    const sc2 = await save({ title: '스코프 제목' }, { authorization: 'Bearer ' + scoped });
    assert.equal(sc2.status, 200, JSON.stringify(sc2.body));

    // ── 스위치 off = 종전 저장(오더는 안 바뀌고 공고만) ──
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    ed = await openEditor();
    const vOff = Number((await wo()).sync_version);
    r = await save({ ...ed.body, work_detail: { ...ed.body.work_detail, specialNotes: '스위치 끄고 공고만' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cRow()).work_detail.specialNotes, '스위치 끄고 공고만');
    assert.equal(Number((await wo()).sync_version), vOff, '오더 그대로(오늘 동작)');
    console.log('campaignSharedSave: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id=$1', [sid]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE source_review_order_id=$1', [sid]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('campaignSharedSave: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
