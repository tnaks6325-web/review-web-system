/**
 * receiptReviewerCancel.test.js — 영수증리뷰: 리뷰어가 리뷰를 내기 **전에** 스스로 참여 취소 (결정 434 사용자 확정 2026-11-28 ①)
 * 실행: node tests/receiptReviewerCancel.test.js
 *
 * 위험:
 *  ① 영수증을 받은(참여 확정 = submitted) 리뷰어가 그만둘 길이 없다(막다른 길) — 또는 그만둬도 영수증·작업표 줄·장부 줄이 남아
 *     다음 참여자가 그 영수증을 못 받는다.
 *  ② 취소한 리뷰어가 그 영수증 사진을 계속 본다(배정이 넘어간 뒤 남의 영수증).
 *  ③ 리뷰를 낸 뒤에도 취소된다(영수증 한 장에 리뷰 한 번 — 낸 영수증은 그 사람 것).
 *  ④ 남이(다른 리뷰어 세션·무인증) 내 참여를 취소한다.
 * ★ 실제 처리기(POST /api/campaign/:id/cancel · /api/submit/receipt · /receipt/image · work-detail)와 실제 실행부
 *   (reviewerOrderCancel → trackB.hideWorkdeskRow = 담당자 [줄 삭제]와 같은 함수)를 PGlite(저장소 migrations 그대로)에서 돌린다.
 *   운영 DB·드라이브에 닿지 않는다(가짜 이름·가짜 매장·가짜 파일 번호 · 드라이브 읽기는 가짜로 세기만).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const SOFT = process.env.DL_SOFT === '1';
const fails = [];
const t = (name, cond, extra) => {
  if (!cond && SOFT) { fails.push(name); console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); return; }
  assert(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 800) : ''));
  pass++; console.log('  ✓ ' + name);
};
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const SERVER = path.join(__dirname, '..');
const TAB = '12월 가짜카페 영수증취소';
const WO = 'wo_receipt_cancel';
const CAMP = 'camp_receipt_cancel';
const OPT = '가짜카페 선릉점';
const FID = n => `fake_rcancel_${String(n).padStart(4, '0')}_abcdefghijk`;
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-receipt-cancel-secret';
process.env.ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || 'root-folder-test';

async function openDb() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장을 쓰는 몇 파일 — 이 시험의 표와 무관 */ }
  }
  return db;
}
function poolOf(db) {
  const query = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
}
function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {}, sent: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.send = b => { res.sent = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.setHeader = res.set;
  return res;
}
function handlerOf(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  return layer && layer.route.stack[layer.route.stack.length - 1].handle;
}

(async () => {
  console.log('\n▶ 영수증리뷰 — 리뷰 전 리뷰어 스스로 참여 취소(결정 434 · 2026-11-28 ①)\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);
  const rp = require('../src/services/receiptPool.service');
  const drive = require('../src/services/drive.service');
  const reads = [];
  drive.downloadFile = async (id) => { reads.push(id); return { buffer: Buffer.from('IMG:' + id), mimeType: 'image/jpeg', name: id }; };
  // 1:1 문의방 안내(커밋 뒤 후처리)는 외부 표가 없어도 취소를 막지 않는다 — 부른 글자만 센다.
  const cs = require('../src/services/csBridge.service');
  const notices = [];
  cs.postAdminNotice = async (n) => { notices.push(n); return { ok: true }; };

  /* ── 준비: 영수증 작업표 2줄 · 공고 ─────────────────────────── */
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const receipts = [1, 2].map(n => ({ file_id: FID(n) }));
  const place = { name: OPT, url: 'https://map.naver.com/p/entry/place/0000001', option_schema_version: 2, product_mode: 'none',
    base: { pay: 0, count: 2, daily: 0, review_type_mix: [] }, options: [], receipt: { review_deadline_days: 3, place_address: '서울 가짜구 가짜로 2', receipts } };
  const wo = { id: WO, title: TAB, work_kind: 'receipt', workboard_schema_version: 2, recruit_count: 2, review_fee: 5000, pay_amount: 0, start_date: null,
    product_options_json: JSON.stringify([place]) };
  await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status)
           VALUES ($1, $2, 'receipt', 2, 2, 5000, 0, $3, 'published')`, [WO, TAB, wo.product_options_json]);
  for (const r of receipts) await rp.registerReceiptUpload(r.file_id, { source: 'upload:intranet', mimeType: 'image/jpeg' });
  const made = await require('../src/services/sheetlessAccept.service').createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' });
  const sheetId = made.sheetId;
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'receipt', TRUE, 2)`, [sheetId, TAB, made.gid]);
  await made.persist();
  await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid, work_kind,
             recruit_total, daily_limit, hold_ttl_min, multi_account_mode, review_fee)
           VALUES ($1, $2, 'active', TRUE, $3, $4, $5, 'receipt', 2, 2, 20, FALSE, 5000)`, [CAMP, OPT, sheetId, TAB, made.gid]);
  await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order)
           VALUES ($1, $2, $2, 'product', 0, 2, 0, 'active', 0)`, [CAMP, OPT]);

  const wk = require('../src/utils/workKind');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const apply = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const cancelH = handlerOf(campaignRoutes, 'post', '/:id/cancel');
  const detailH = handlerOf(campaignRoutes, 'get', '/:id/work-detail');
  const joinH = handlerOf(submitRoutes, 'post', '/receipt');
  const imgH = handlerOf(submitRoutes, 'post', '/receipt/image');
  const call = async (h, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const res = fakeRes(); let err = null;
    await h({ body, params, query, headers, ip: '127.0.0.1', get: () => '' }, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  const people = [['가짜취소하나', '01021112222'], ['가짜취소둘', '01023334444'], ['가짜취소셋', '01025556666']];
  for (const [n, ph] of people) {
    await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address) VALUES ($1, $2, '가짜은행', $3, $1, '서울 가짜구')`, [n, ph, '000-' + ph.slice(-4)]);
  }
  const rs = require('../src/services/reviewerSession.service');
  const who = async (i) => {
    const [n, ph] = people[i]; const p8 = ph.slice(-8);
    const id = (await q('SELECT id FROM reviewers WHERE phone8 = $1', [p8])).rows[0].id;
    return { name: n, phone: ph, p8, id, H: { 'x-reviewer-token': rs.issueReviewerSession({ ownerReviewerId: id, loginName: n, loginPhone8: p8 }) } };
  };
  const A = await who(0), B = await who(1), C = await who(2);
  const joinBody = (app, p) => ({ campaignId: CAMP, campaignApplicationId: app.applicationId, holdToken: app.holdToken, holdPhone8: p.p8, loginPhone8: p.p8 });
  const doApply = async (p) => call(apply, { params: { id: CAMP }, body: { name: p.name, phone: p.phone, optionKey: OPT }, headers: p.H });
  const joinAs = async (p) => {   // 참여 → 영수증 배정 → 참여 확정(submitted · 그 줄 기록)
    const a = await doApply(p);
    assert(a.statusCode === 200 && a.body.ok, 'apply ' + JSON.stringify(a.body));
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [a.body.applicationId, p.id]);
    const j = await call(joinH, { body: joinBody(a.body, p), headers: p.H });
    assert(j.statusCode === 200 && j.body.ok, 'join ' + JSON.stringify(j.body));
    return { app: a.body, target: j.body.target, orderId: j.body.orderSubmissionId };
  };
  const cancelAs = (p, app, headers) => call(cancelH, { params: { id: CAMP }, body: { phone8: p.p8, holdToken: app.holdToken }, headers: headers === undefined ? p.H : headers });
  const appStatus = async (id) => (await q('SELECT status, hold_token FROM campaign_applications WHERE id = $1', [id])).rows[0];
  const rowAt = async (seq) => (await q(`SELECT id, order_submission_id, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`, [sheetId, TAB, seq])).rows[0];

  const saved = wk.NOT_READY_WORK_KINDS.slice();
  wk.NOT_READY_WORK_KINDS.length = 0;   // ★ 시험 안에서만 — 흐름을 돌리려고 비운다(끝에 saved 로 되돌림)
  try {
    /* ── 1) 영수증을 받은 뒤(submitted) 리뷰 전 취소 ───────────── */
    console.log('1) 참여 확정 뒤(영수증 받음) · 리뷰 전 — 본인만 취소');
    const jA = await joinAs(A);
    const poolA = await rp.poolForApplication(pool, jA.app.applicationId);
    t('준비: A = 1번 영수증 · 참여 확정(submitted) · 그 줄에 장부 줄', poolA.pool_seq === 1 && (await appStatus(jA.app.applicationId)).status === 'submitted'
      && String((await rowAt(poolA.seq)).order_submission_id) === String(jA.orderId));
    const det0 = await call(detailH, { params: { id: CAMP }, query: { phone8: A.p8, holdToken: jA.app.holdToken } });
    t('★ 참여 상세: 영수증 받음 · 리뷰 아직(= 취소 버튼을 보일 상태)', det0.body.receiptSeat && det0.body.receiptSeat.joined === true && det0.body.receiptSeat.reviewDone === false);
    const freeBefore = (await rp.freeCountsForTab(pool, sheetId, TAB)).free;

    const cNo = await cancelAs(A, jA.app, {});
    t('★★ 무인증(리뷰어 세션 없음) = 401 · 아무것도 안 바뀜', cNo.statusCode === 401 && (await appStatus(jA.app.applicationId)).status === 'submitted', cNo.body);
    const cOther = await cancelAs(A, jA.app, B.H);
    t('★★★ 다른 리뷰어 세션 = 403 · 아무것도 안 바뀜', cOther.statusCode === 403 && (await appStatus(jA.app.applicationId)).status === 'submitted', cOther.body);
    const cBadTok = await call(cancelH, { params: { id: CAMP }, body: { phone8: A.p8, holdToken: 'wrong' }, headers: A.H });
    t('홀드 토큰이 틀리면 404(종전 문구 그대로)', cBadTok.statusCode === 404 && (await appStatus(jA.app.applicationId)).status === 'submitted', cBadTok.body);
    wk.NOT_READY_WORK_KINDS.push('receipt');
    const cPin = await cancelAs(A, jA.app);
    wk.NOT_READY_WORK_KINDS.length = 0;
    t('★ 준비 중 안전핀(배포 그대로)이면 409 work_kind_not_ready · 아무것도 안 바뀜', cPin.statusCode === 409 && cPin.body.code === 'work_kind_not_ready'
      && (await appStatus(jA.app.applicationId)).status === 'submitted', cPin.body);

    const cA = await cancelAs(A, jA.app);
    t('★★★ 본인 = 200 · 참여 취소됨', cA.statusCode === 200 && cA.body.ok === true && /영수증/.test(cA.body.message || ''), cA.body);
    t('★★ 신청 = cancelled(살아 있는 신청이 아니다 → 영수증을 놓는다)', (await appStatus(jA.app.applicationId)).status === 'cancelled');
    const os = (await q('SELECT deleted_at, mirror_status FROM order_submissions WHERE id = $1', [jA.orderId])).rows[0];
    t('★★ 장부 줄(참여 확정 주문) 무효(담당자 [줄 삭제]와 같은 실행부 — 주문 취소)', os && os.deleted_at != null, os);
    t('★★ 그 작업표 줄은 지워지고 삭제 표식이 남는다(같은 번호가 되살지 않음)', !(await rowAt(poolA.seq))
      && (await q('SELECT 1 FROM workdesk_participant_deletions WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3', [sheetId, TAB, poolA.seq])).rows.length === 1);
    const pool1 = (await rp.poolForTab(pool, sheetId, TAB)).find(x => x.pool_seq === 1);
    const newRow = await rowAt(pool1.seq);
    t('★★★ 1번 영수증은 새 보충 줄로 옮겨 갔다(영수증 칸 「1번」 · 주문 없음 · 참여일자 빈칸)', pool1.seq !== poolA.seq && newRow && !newRow.order_submission_id
      && newRow.row_json['영수증'] === '1번' && !String(newRow.row_json['참여일자'] || '').trim(), { pool1, newRow });
    t('★★ 남은 영수증이 한 장 늘었다(반납 쓰기 없음 — 신청 표가 단일 출처)', (await rp.freeCountsForTab(pool, sheetId, TAB)).free === freeBefore + 1);
    t('1:1 문의방 안내 = 영수증 문구(「구매양식」 아님)', notices.length === 1 && /영수증/.test(notices[0].message) && !/구매양식/.test(notices[0].message), notices);

    /* ── 2) 취소 뒤 그 리뷰어는 영수증을 못 본다 ─────────────────── */
    console.log('\n2) 취소한 리뷰어 = 영수증·참여 확정·참여 상세 모두 거절');
    reads.length = 0;
    const img = await call(imgH, { body: joinBody(jA.app, A), headers: A.H });
    t('★★★ 내 영수증 통로 = 거절(403/409) · 드라이브 읽기 0', (img.statusCode === 403 || img.statusCode === 409) && reads.length === 0, { s: img.statusCode, b: img.body });
    const rejoin = await call(joinH, { body: joinBody(jA.app, A), headers: A.H });
    t('★★ 참여 확정 창구도 거절(다시 확정해 영수증 줄을 되찾지 못함)', rejoin.statusCode === 409 || rejoin.statusCode === 403, rejoin.body);
    const det1 = await call(detailH, { params: { id: CAMP }, query: { phone8: A.p8, holdToken: jA.app.holdToken } });
    t('★ 참여 상세 = 끝난 참여(403 · 영수증 칸 없음)', det1.statusCode === 403 && !(det1.body && det1.body.receiptSeat), det1.body);
    const again = await cancelAs(A, jA.app);
    t('다시 눌러도 = 404(취소할 참여 없음 · 다른 사람 줄을 건드리지 않음)', again.statusCode === 404, again.body);

    /* ── 3) 다음 참여자가 같은 영수증을 새 줄로 받는다 ─────────────── */
    console.log('\n3) 다음 참여자 = 같은 영수증 번호 · 새 줄');
    const jB = await joinAs(B);
    const poolB = await rp.poolForApplication(pool, jB.app.applicationId);
    t('★★★ 다음 참여자 B 가 돌아온 1번 영수증을 받는다', poolB.pool_seq === 1 && poolB.id === poolA.id);
    t('★★★ B 의 참여 확정은 새 보충 줄에 쓴다(옛 줄 아님)', Number(jB.target.rowIndex) === pool1.seq && String((await rowAt(pool1.seq)).order_submission_id) === String(jB.orderId));
    reads.length = 0;
    const imgB = await call(imgH, { body: joinBody(jB.app, B), headers: B.H });
    t('★ B 는 1번 영수증 사진을 본다', imgB.statusCode === 200 && String(imgB.sent) === 'IMG:' + FID(1) && reads.join() === FID(1));
    reads.length = 0;
    const imgA2 = await call(imgH, { body: joinBody(jA.app, A), headers: A.H });
    t('★★★ 그래도 A 는 그 영수증을 못 본다(배정이 넘어간 뒤 남의 영수증)', imgA2.statusCode !== 200 && reads.length === 0, imgA2.statusCode);

    /* ── 4) 리뷰를 낸 뒤 = 취소 안 됨(409) ─────────────────────── */
    console.log('\n4) 리뷰 낸 뒤 = 리뷰어 취소 거절');
    // 리뷰 제출 완료 트랜잭션이 남기는 것과 같은 표시(작업표 줄 is_submitted · 리뷰 색인) + 커밋 뒤 「리뷰 냄」(markReviewedRow)
    await q(`UPDATE campaign_participants SET is_submitted = TRUE WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, pool1.seq]);
    await rp.markReviewedRow(pool, sheetId, TAB, pool1.seq);
    const detB = await call(detailH, { params: { id: CAMP }, query: { phone8: B.p8, holdToken: jB.app.holdToken } });
    t('참여 상세: 리뷰 냄(= 완료 화면 · 취소 버튼 없음)', detB.body.receiptSeat && detB.body.receiptSeat.reviewDone === true);
    const cB = await cancelAs(B, jB.app);
    t('★★★ 리뷰 낸 뒤 취소 = 409 · 리뷰 냈다는 말', cB.statusCode === 409 && /리뷰/.test(cB.body.error || '') && cB.body.code === 'review_submitted', cB.body);
    t('★★ 아무것도 안 바뀜(신청 submitted · 줄 그대로 · 장부 살아 있음)', (await appStatus(jB.app.applicationId)).status === 'submitted'
      && String((await rowAt(pool1.seq)).order_submission_id) === String(jB.orderId)
      && (await q('SELECT deleted_at FROM order_submissions WHERE id = $1', [jB.orderId])).rows[0].deleted_at == null);
    // 「리뷰 냄」 표시만 있고 작업표 표시가 없어도(커밋 뒤 표시 순서) 거절
    await q(`UPDATE campaign_participants SET is_submitted = FALSE WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, pool1.seq]);
    const cB2 = await cancelAs(B, jB.app);
    t('★★ 영수증 줄 「리뷰 냄」(reviewed_at)만 있어도 409', cB2.statusCode === 409 && (await appStatus(jB.app.applicationId)).status === 'submitted', cB2.body);
    // 잠금 안 재확인(TOCTOU) — 판정 뒤·삭제 전에 리뷰가 들어온 경우: 실행부가 잠근 줄을 다시 보고 되돌린다
    await q(`UPDATE receipt_pool SET reviewed_at = NULL WHERE id = $1`, [poolB.id]);
    await q(`UPDATE campaign_participants SET is_submitted = TRUE WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, pool1.seq]);
    const tb = require('../src/services/trackB.service');
    const rowB = await rowAt(pool1.seq);
    const h = await tb.hideWorkdeskRow({ sheetId, tabName: TAB, rowId: rowB.id, by: 'reviewer:test', requireNoReview: true });
    t('★★★ 실행부 잠금 안 재확인: 리뷰 낸 줄은 지우지 않는다(review_submitted · 주문·신청·줄 그대로 — 한 트랜잭션 되돌림)', h && h.ok === false && h.error === 'review_submitted'
      && (await appStatus(jB.app.applicationId)).status === 'submitted' && !!(await rowAt(pool1.seq))
      && (await q('SELECT deleted_at FROM order_submissions WHERE id = $1', [jB.orderId])).rows[0].deleted_at == null, h);
    const hStaff = await tb.hideWorkdeskRow({ sheetId, tabName: TAB, rowId: rowB.id, by: 'test', actorRole: 'admin' });
    t('담당자 [줄 삭제](requireNoReview 없음)는 종전대로 지운다(동작 불변)', hStaff && hStaff.ok === true, hStaff);

    /* ── 5) 확정 전(받는 중 · applied) 취소는 종전 길 그대로 ────────── */
    console.log('\n5) 확정 전 홀드 취소 = 종전 길(세션 없이도)');
    const aC = await doApply(C);
    const cC = await cancelAs(C, aC.body, {});
    t('★ 확정 전 홀드는 종전처럼 phone8 + 홀드 토큰으로 취소(200 · 영수증 놓음)', cC.statusCode === 200 && (await appStatus(aC.body.applicationId)).status === 'cancelled', cC.body);
  } finally {
    wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...saved);
  }
  t('★★ 시험 뒤 준비 중 목록 원상 복귀(배포 그대로 · receipt 포함)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(saved) && wk.NOT_READY_WORK_KINDS.includes('receipt'));

  /* ── 6) 화면 계약 ─────────────────────────────────────────── */
  console.log('\n6) 화면 계약(campaign.html)');
  const cv = F('campaign.html');
  const card = cv.slice(cv.indexOf('function renderReceiptCard('), cv.indexOf('async function onReceiptJoin('));
  t('★★ 영수증 카드: [참여 취소]는 리뷰 전이면 보인다(영수증 받은 뒤에도) — 숨기지 않는다', /joinedCancelBtn'\)\.style\.display = ''/.test(card) && !/joinedCancelBtn'\)\)\s*\$\('joinedCancelBtn'\)\.style\.display = joined \? 'none'/.test(card));
  const oc = cv.slice(cv.indexOf('async function onCancel('), cv.indexOf('function _pvCaptureToken('));
  t('★★ 확인 창 문구(영수증): 「참여를 취소할까요? 받은 영수증은 다른 분께 넘어가고 다시 볼 수 없어요」', /참여를 취소할까요\?\\n받은 영수증은 다른 분께 넘어가고 다시 볼 수 없어요/.test(oc));
  t('★ 취소 요청에 리뷰어 세션 헤더를 싣는다(서버 본인 확인)', /\/cancel', \{[\s\S]{0,400}_getAuthHeaders\(\)/.test(oc));
  t('★★ 취소 성공 = 영수증 사진을 화면에서 지운다(_rcDropImage · 늦게 온 사진 응답도 버림)', /_rcDropImage\(\)/.test(oc) && /function _rcDropImage\(\)\{[\s\S]{0,300}_rcImgSeq\+\+[\s\S]{0,300}revokeObjectURL/.test(cv));

  if (fails.length) { console.log(`\n✗ ${fails.length} failed (soft)`); process.exit(1); }
  console.log(`\n✅ receiptReviewerCancel: ${pass}개 통과\n`);
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
