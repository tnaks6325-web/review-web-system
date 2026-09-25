/**
 * reviewAsyncInspect.test.js — 제출 응답에서 검수를 떼어낸 뒤에도 검수가 **실제로 도는지**
 *
 * 배경(사용자 확정 2026-09-26): 리뷰어는 사진만 올라가면 바로 완료 화면을 보고,
 * 검사는 뒤에서 돈다. 그런데 응답 뒤 코드는 **조용히 죽어도 아무도 모른다**
 * (setImmediate 안의 예외는 catch 에 삼켜지고 화면은 정상으로 보인다).
 * 이 레포가 반복해 밟은 "문자열은 멀쩡한데 스코프가 다른" 사고가 바로 이 자리다.
 * → 실제 Express 라우터에 요청을 보내고, 응답 시점과 그 뒤를 나눠서 **호출을 센다**.
 *
 * [A] 응답이 검수를 기다리지 않는다(응답 시점 inspectSubmission 0회)
 * [B] 응답 뒤 검수가 **끝까지** 돈다(형식 검수 → 2차 검수) — 스코프 오류 0
 * [C] `확인 중`의 근거인 pending 행을 응답 전에 남긴다
 * [D] 중복이면 리뷰어 문의방 안내가 자동으로 나간다 (사용자 확정 ③)
 * [E] 킬스위치 / auto 모드에서는 종전대로 동기
 *
 * 실행: node tests/reviewAsyncInspect.test.js
 */
const assert = require('assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'async-inspect-test-secret';
process.env.AUTO_FILE_ROUTE = 'dry';
process.env.AI_REVIEW_FOLDER_ID = process.env.AI_REVIEW_FOLDER_ID || 'TEST_ROOT_FOLDER';           // 운영 기본값과 같게(이동 0)

const pool = require('../src/db/pool');
const driveService = require('../src/services/drive.service');
const reviewInspect = require('../src/services/reviewInspect.service');
const captureVerify = require('../src/services/captureVerify.service');
const reviewCheck = require('../src/services/reviewCheck.service');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* ── 스텁 ──────────────────────────────────────────────── */
const calls = { verify: 0, inspect: 0, notify: 0, pendingInsert: 0, upload: 0 };
let duplicateFail = false;
const notified = new Set();
let lastNotify = null;

const q = async (sql, params = []) => {
  if (/FROM tab_configs/.test(sql)) {
    return { rows: [{
      folder_url: 'https://drive.google.com/drive/folders/FOLDER_X',
      capture_folder_url: null, capture_slots: null, income_type: null, tab_gid: '0',
    }] };
  }
  if (/FROM review_index\b/.test(sql) && /SELECT id/.test(sql)) return { rows: [{ id: 'RI-1' }] };
  if (/INSERT INTO review_inspections/.test(sql)) { calls.pendingInsert++; return { rows: [], rowCount: 1 }; }
  // 반려 안내 선점(UPDATE ... RETURNING) — 한 번만 잡히게 흉내 낸다
  if (/UPDATE review_inspections/.test(sql) && /reviewer_notified_at = NOW\(\)/.test(sql)) {
    const id = String(params[0] || '');
    if (notified.has(id)) return { rows: [] };
    notified.add(id);
    return { rows: [{ file_id: id }] };
  }
  return { rows: [], rowCount: 1 };
};
pool.query = q;
reviewInspect.__setPoolForTest({ query: q });

driveService.uploadFileBase64 = async (b64, name) => {
  calls.upload++;
  return { id: 'FILE_' + calls.upload, name, webViewLink: 'https://drive.google.com/file/d/X/view' };
};
driveService.trashFiles = async () => ({ ok: true });
driveService.ensureReviewFolderPath = async () => ({ id: 'FOLDER_X', name: '[리뷰]' });
driveService.ensureCaptureFolderPath = async () => ({ id: 'FOLDER_C', name: '[구매캡처]' });
driveService.getOrCreateSubFolder = async () => ({ id: 'FOLDER_SUB', name: 'sub' });
driveService.findFolderByName = async () => ({ id: 'FOLDER_X', name: '[리뷰]' });
driveService.createFolder = async () => ({ id: 'FOLDER_X', name: '[리뷰]' });
driveService.moveFile = async () => ({ ok: true });

captureVerify.verifyCapture = async () => { calls.verify++; return { status: 'ok', message: '', sure: false }; };
captureVerify.logCaptureMismatch = async () => {};
captureVerify.resolveCaptureMismatch = async () => {};

const SLOW_MS = 400;   // 검수가 느린 날을 흉내 — 응답이 이걸 기다리는지로 판정한다
reviewInspect.inspectSubmission = async () => {
  calls.inspect++;
  await new Promise(r => setTimeout(r, SLOW_MS));
  return duplicateFail
    ? { status: 'fail', checks: { duplicate: { verdict: 'fail', matchFileId: 'OLD_FILE' } } }
    : { status: 'pass', checks: { duplicate: { verdict: 'pass' } } };
};
reviewInspect.notifyInspectionReject = async (p) => { calls.notify++; lastNotify = p; return { sent: true }; };
reviewInspect.submissionSamples = async () => [];
reviewInspect.loadTabExpectations = async () => ({ expectedChannel: 'coupang' });

// 행 소유 확인은 이 가드의 관심사가 아니다 — 통과시킨다(403 게이트는 별도 가드가 지킨다)
require('../src/services/reviewerTargetOwnership.service').ownsReviewerTarget =
  async () => ({ ok: true, owned: true });

const router = require('../src/routes/diag.routes');
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/api/image', router);

const body = (over = {}) => ({
  sheetId: 'SHEET-A', tabName: '작업탭', rowIndex: 7, reviewerName: '김리뷰',
  slotKey: 'review', files: [{ data: 'aGVsbG8td29ybGQ=', mimeType: 'image/jpeg' }],
  ...over,
});
const post = (base, path, token, b) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Reviewer-Token': token } : {}) },
  body: JSON.stringify(b),
}).then(async r => ({ status: r.status, body: await r.json() }));

/* 뒤 작업이 끝날 때까지 기다린다(고정 sleep 은 검수 지연이 바뀌면 조용히 깨진다) */
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};
const flush = () => waitFor(() => false, 60);
const reset = () => { notified.clear(); calls.verify = calls.inspect = calls.notify = calls.pendingInsert = calls.upload = 0; lastNotify = null; };

(async () => {
  console.log('\n▶ reviewAsyncInspect 회귀가드\n');
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = issueReviewerSession({ ownerReviewerId: 'o1', loginName: '김리뷰', loginPhone8: '12345678' });

  try {
    // ── A. 응답이 검수를 기다리지 않는다 ──────────────────
    delete process.env.REVIEW_UPLOAD_ASYNC_INSPECT;
    reset();
    /* ★ "응답 시점에 0회"로는 잴 수 없다 — 응답이 오가는 사이에 뒤 작업이 이미 시작된다.
       검수를 일부러 느리게 만들고 **응답이 그걸 기다렸는지**를 시간으로 본다. */
    const t0 = Date.now();
    const r1 = await post(base, '/api/image/review-upload', token, body());
    const took = Date.now() - t0;
    assert.strictEqual(r1.status, 200, '업로드 응답 200');
    assert.ok(r1.body.ok, `업로드 성공이어야 한다: ${JSON.stringify(r1.body).slice(0, 200)}`);
    assert.ok(took < SLOW_MS,
      `응답이 검수(${SLOW_MS}ms)를 기다리면 안 된다 — 실제 ${took}ms. ` +
      '기다린다면 리뷰어가 그 시간만큼 완료 화면을 못 본다(이 변경의 이유).');
    ok(`A1: 응답이 검수를 기다리지 않는다 (${took}ms < ${SLOW_MS}ms)`);

    // ── C. 확인 중의 근거 = pending 행 ───────────────────
    assert.ok(calls.pendingInsert >= 1,
      '응답 전에 review_inspections pending 행을 남겨야 한다(리뷰어 화면의 "확인 중" 근거)');
    ok('C1: 응답 전에 검수 예약(pending)을 남긴다');

    // ── B. 응답 뒤 검수가 끝까지 돈다 ────────────────────
    await waitFor(() => calls.inspect >= 1 && calls.verify >= 1);
    assert.ok(calls.verify >= 1, `응답 뒤 형식 검수가 돌아야 한다 — 실제 ${calls.verify}회`);
    assert.ok(calls.inspect >= 1,
      `응답 뒤 2차 검수가 돌아야 한다 — 실제 ${calls.inspect}회. ` +
      '0 이면 추출한 함수가 스코프 밖 변수를 참조해 조용히 죽은 것이다(이 레포의 반복 사고).');
    ok('B1: 응답 뒤 형식 검수 → 2차 검수가 실제로 끝까지 돈다');

    // ── D. 중복이면 문의방 안내 ──────────────────────────
    reset(); duplicateFail = true;
    const r2 = await post(base, '/api/image/review-upload', token, body({ rowIndex: 8 }));
    assert.ok(r2.body.ok, '중복이어도 업로드 응답 자체는 성공이다(제출은 받는다)');
    await waitFor(() => calls.notify >= 1);
    assert.strictEqual(calls.notify, 1,
      `중복 반려면 리뷰어 문의방 안내가 1회 나가야 한다 — 실제 ${calls.notify}회`);
    assert.ok(lastNotify && /중복/.test(String(lastNotify.message || '')),
      '안내 문구는 중복 유형 기본 문구여야 한다');
    assert.ok(lastNotify && lastNotify.card && lastNotify.card.kind === 'duplicate'
      && lastNotify.card.matchFileId === 'OLD_FILE',
      '카드에 "이미 제출된 사진"을 함께 실어 두 장을 나란히 보여준다');
    assert.strictEqual(String(lastNotify.by || ''), 'system:auto',
      '보낸 주체는 시스템 — 관리자 실명이 들어가면 안 된다');
    ok('D1: 중복이면 문의방 안내 1회 + 사진 두 장 카드 + 발신자 system');

    // ── E. 킬스위치 / auto 모드는 종전대로 동기 ──────────
    reset(); duplicateFail = false;
    process.env.REVIEW_UPLOAD_ASYNC_INSPECT = '0';
    const t3 = Date.now();
    const r3 = await post(base, '/api/image/review-upload', token, body({ rowIndex: 9 }));
    const took3 = Date.now() - t3;
    assert.ok(r3.body.ok);
    assert.ok(calls.inspect >= 1,
      `킬스위치가 꺼지면 응답 전에 검수가 끝나야 한다(종전 동작) — 실제 ${calls.inspect}회`);
    assert.ok(took3 >= SLOW_MS,
      `대조군: 동기 모드는 검수를 기다린다 — 실제 ${took3}ms (${SLOW_MS}ms 이상이어야 한다)`);
    assert.strictEqual(calls.pendingInsert, 0, '동기 모드에서는 pending 예약을 만들지 않는다');
    ok('E1: REVIEW_UPLOAD_ASYNC_INSPECT=0 이면 종전대로 응답 전에 검수');
    delete process.env.REVIEW_UPLOAD_ASYNC_INSPECT;

    // ── F. 판정 단일 출처 ────────────────────────────────
    assert.deepStrictEqual(reviewCheck.AUTO_REJECT_CHECKS, ['duplicate'],
      '자동 반려 대상은 중복 하나뿐이다(사용자 확정 — 넓히려면 확정을 다시 받는다)');
    assert.strictEqual(reviewCheck.autoRejectKind({ duplicate: { verdict: 'fail' } }), 'duplicate');
    assert.strictEqual(reviewCheck.autoRejectKind({ duplicate: { verdict: 'warn' } }), null,
      '같은 리뷰어의 다른 작업(warn)은 반려가 아니다');
    assert.strictEqual(reviewCheck.autoRejectKind({ format: { verdict: 'fail' } }), null,
      '리뷰 화면 아님(format)은 아직 자동 반려 대상이 아니다 — 분석 정확도가 올라간 뒤');
    assert.strictEqual(reviewCheck.autoRejectKind({ product: { verdict: 'fail' } }), null,
      '다른 상품(product)도 아직 자동 반려 대상이 아니다');
    assert.strictEqual(reviewCheck.autoRejectKind(null), null, '판정 재료가 없으면 반려가 아니다');
    ok('F1: 자동 반려는 중복 하나뿐 (format·product 는 제외 — 사용자 확정)');

    console.log(`\n✅ reviewAsyncInspect 회귀가드 ${n}케이스 통과`);
  } finally {
    server.close();
  }
  process.exit(0);
})().catch(e => { console.error('❌ 실패:', e.message); process.exit(1); });
