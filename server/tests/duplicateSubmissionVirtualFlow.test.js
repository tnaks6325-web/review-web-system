/**
 * duplicateSubmissionVirtualFlow.test.js
 *
 * 운영 DB·Drive를 사용하지 않고 실제 Express 라우터에 HTTP 요청을 보내는 가상 제출 테스트.
 * - review_index / campaign_participants 완료 상태는 메모리 행으로 대체한다.
 * - Drive 업로드 함수는 호출 횟수만 기록한다.
 * - 완료 중복, 미완료 업로드 흔적, 현재 행 재첨부, 다중 파일 원자 차단을 재현한다.
 */
const assert = require('assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'virtual-review-test-secret-20260911';

const pool = require('../src/db/pool');
const driveService = require('../src/services/drive.service');
const reviewInspect = require('../src/services/reviewInspect.service');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');

const originalPoolQuery = pool.query;
const originalDriveUpload = driveService.uploadFileBase64;
let driveUploadCalls = 0;

const completedBytes = 'virtual-completed-review-image';
const pendingBytes = 'virtual-uploaded-but-not-submitted-image';
const historicalBytes = 'virtual-old-upload-not-used-at-completion';
const siblingBytes = 'virtual-second-image-in-completed-batch';
const uniqueBytes = 'virtual-new-review-image';
const completedHash = reviewInspect.hashBase64(completedBytes);
const pendingHash = reviewInspect.hashBase64(pendingBytes);
const historicalHash = reviewInspect.hashBase64(historicalBytes);
const siblingHash = reviewInspect.hashBase64(siblingBytes);

const virtualRows = [
  {
    file_hash: completedHash, file_id: 'VIRTUAL_COMPLETED_FILE', sheet_id: 'SHEET-A',
    tab_name: '구매양식-완료', row_index: 101, slot_key: 'review', phone8: '12345678',
    ri_submitted: true, cp_submitted: false, submitted_at: '2026-09-10T03:00:00.000Z',
    recipient_name: '김수만', representative: true,
  },
  {
    file_hash: pendingHash, file_id: 'VIRTUAL_PENDING_FILE', sheet_id: 'SHEET-A',
    tab_name: '구매양식-미완료', row_index: 102, slot_key: 'review', phone8: '12345678',
    ri_submitted: false, cp_submitted: false, submitted_at: null, recipient_name: '박대기', representative: true,
  },
  {
    file_hash: historicalHash, file_id: 'VIRTUAL_OLD_UNUSED_FILE', sheet_id: 'SHEET-A',
    tab_name: '구매양식-완료', row_index: 101, slot_key: 'review', phone8: '12345678',
    ri_submitted: true, cp_submitted: true, submitted_at: '2026-09-10T03:00:00.000Z',
    recipient_name: '김수만', representative: false,
  },
  {
    file_hash: siblingHash, file_id: 'VIRTUAL_COMPLETED_SIBLING', sheet_id: 'SHEET-A',
    tab_name: '구매양식-완료', row_index: 101, slot_key: 'review', phone8: '12345678',
    ri_submitted: true, cp_submitted: true, submitted_at: '2026-09-10T03:00:01.000Z',
    recipient_name: '김수만', representative: false, same_batch: true,
  },
];

function duplicateQuery(sql, params) {
  if (!/FROM review_submissions s/.test(sql)) return { rows: [] };
  const [hash, fallbackName, sheetId, tabName, rowIndex, phone8] = params;
  const rows = virtualRows
    .filter((r) => r.file_hash === hash && r.slot_key === 'review')
    .filter((r) => r.phone8 === phone8)
    .filter((r) => r.representative || r.same_batch)
    .filter((r) => r.ri_submitted || r.cp_submitted)
    .filter((r) => !(r.sheet_id === sheetId && r.tab_name === tabName
      && Number(r.row_index) === Number(rowIndex)))
    .map((r) => ({
      file_id: r.file_id, sheet_id: r.sheet_id, tab_name: r.tab_name,
      row_index: r.row_index, submitted_at: r.submitted_at,
      recipient_name: r.recipient_name || fallbackName,
    }));
  return { rows };
}

pool.query = async (sql, params = []) => duplicateQuery(sql, params);
reviewInspect.__setPoolForTest({ query: async (sql, params = []) => duplicateQuery(sql, params) });
driveService.uploadFileBase64 = async () => {
  driveUploadCalls++;
  throw new Error('가상테스트에서 Drive 업로드가 호출되면 안 됩니다.');
};

const router = require('../src/routes/diag.routes');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/image', router);
app.use((err, req, res, next) => res.status(500).json({ ok: false, error: err.message }));

function post(baseUrl, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Reviewer-Token'] = token;
  return fetch(baseUrl + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = issueReviewerSession({
    ownerReviewerId: 'virtual-owner', loginName: '가상리뷰어', loginPhone8: '12345678',
  });

  try {
    console.log('\n가상 리뷰 제출 흐름');

    const completed = await post(baseUrl, '/api/image/review-precheck', token, {
      base64: completedBytes, mimeType: 'image/png', sheetId: 'SHEET-B',
      tabName: '현재구매양식', rowIndex: 201, reviewerName: '조작된이름', phone8: '00000000', slotKey: 'review',
    });
    assert.strictEqual(completed.status, 200);
    assert.strictEqual(completed.body.duplicate.fileId, 'VIRTUAL_COMPLETED_FILE');
    assert.strictEqual(completed.body.duplicate.recipientName, '김수만');
    console.log('  통과 ① 완료된 타 구매양식 동일 사진 → 중복 이력 반환');

    const pending = await post(baseUrl, '/api/image/review-precheck', token, {
      base64: pendingBytes, mimeType: 'image/png', sheetId: 'SHEET-B',
      tabName: '현재구매양식', rowIndex: 201, slotKey: 'review',
    });
    assert.strictEqual(pending.status, 200);
    assert.strictEqual(pending.body.duplicate, null);
    console.log('  통과 ② 업로드 흔적만 있고 is_submitted=FALSE → 중복 아님');

    const currentRow = await post(baseUrl, '/api/image/review-precheck', token, {
      base64: completedBytes, mimeType: 'image/png', sheetId: 'SHEET-A',
      tabName: '구매양식-완료', rowIndex: 101, slotKey: 'review',
    });
    assert.strictEqual(currentRow.status, 200);
    assert.strictEqual(currentRow.body.duplicate, null);
    console.log('  통과 ③ 현재 구매양식의 같은 행 재첨부 → 중복 아님');

    const historical = await post(baseUrl, '/api/image/review-precheck', token, {
      base64: historicalBytes, mimeType: 'image/png', sheetId: 'SHEET-B',
      tabName: '현재구매양식', rowIndex: 201, slotKey: 'review',
    });
    assert.strictEqual(historical.status, 200);
    assert.strictEqual(historical.body.duplicate, null);
    console.log('  통과 ④ 완료 행에 남은 과거 미사용 업로드 → 중복 아님');

    const sibling = await post(baseUrl, '/api/image/review-precheck', token, {
      base64: siblingBytes, mimeType: 'image/png', sheetId: 'SHEET-B',
      tabName: '현재구매양식', rowIndex: 201, slotKey: 'review',
    });
    assert.strictEqual(sibling.status, 200);
    assert.strictEqual(sibling.body.duplicate.fileId, 'VIRTUAL_COMPLETED_SIBLING');
    console.log('  통과 ⑤ 완료된 다중 이미지 묶음의 두 번째 사진 → 중복');

    const unauthenticated = await post(baseUrl, '/api/image/review-upload', null, {
      sheetId: 'SHEET-B', tabName: '현재구매양식', rowIndex: 201,
      reviewerName: '가상리뷰어', slotKey: 'review',
      files: [{ data: uniqueBytes, mimeType: 'image/png', name: '새사진.png' }],
    });
    assert.strictEqual(unauthenticated.status, 401);
    assert.strictEqual(unauthenticated.body.code, 'REVIEW_UPLOAD_AUTH_REQUIRED');
    assert.strictEqual(driveUploadCalls, 0);
    console.log('  통과 ⑥ 인증 없는 리뷰 업로드 → 저장 전 401 거부');

    const upload = await post(baseUrl, '/api/image/review-upload', token, {
      sheetId: 'SHEET-B', tabName: '현재구매양식', rowIndex: 201,
      reviewerName: '가상리뷰어', slotKey: 'review',
      files: [
        { data: uniqueBytes, mimeType: 'image/png', name: '새사진.png' },
        { data: completedBytes, mimeType: 'image/png', name: '중복사진.png' },
      ],
    });
    assert.strictEqual(upload.status, 200);
    assert.strictEqual(upload.body.ok, false);
    assert.strictEqual(upload.body.uploaded, 0);
    assert.strictEqual(upload.body.error, '이미 제출됬던 사진이에요');
    assert.strictEqual(upload.body.files[0].rejected, 'duplicate_submitted');
    assert.strictEqual(driveUploadCalls, 0);
    console.log('  통과 ⑦ 두 장 중 한 장이 완료 중복 → 두 장 모두 저장 전 차단');
    console.log('  통과 ⑧ Drive 업로드 호출 0회 → 차단 후 외부 저장 없음');

    console.log('\n결과: 8 통과 / 0 실패 (운영 DB·Drive 접촉 0)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    reviewInspect.__setPoolForTest(null);
    pool.query = originalPoolQuery;
    driveService.uploadFileBase64 = originalDriveUpload;
  }
})().catch((err) => {
  console.error('\n가상테스트 실패:', err);
  reviewInspect.__setPoolForTest(null);
  pool.query = originalPoolQuery;
  driveService.uploadFileBase64 = originalDriveUpload;
  process.exit(1);
});
