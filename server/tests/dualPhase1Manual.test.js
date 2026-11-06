'use strict';
// 1차 운영 범위(사용자 확정 2026-11-06 「1번」): 동시진행 주문의 드문 경우 — 구매사진 교체·복원,
// 리뷰 파일 이동·되돌리기·자동분류, 중복파일 수동·자동 제거, 리뷰 사진 교체 — 는 막고 직원이 따로 처리한다.
// 일반 주문의 같은 기능은 그대로 동작해야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const runtime = require('../src/services/dualChannelRuntime.service');
const review = require('../src/services/dualChannelReview.service');
const { DUAL_PHASE1_MANUAL } = require('../src/utils/dualPhase1');
const ALL_READY = { version: 1, settings: true, roundtrip: true, recruitment: true, purchase: true, review: true, payment: true, operationalEnabled: true };
const orderId = '00000000-0000-0000-0000-000000000011';

test('staff purchase-photo replace/restore is closed in phase 1 even when every readiness flag is on', async () => {
  const { createDualStaffPurchaseRouter } = require('../src/routes/dualChannelStaffHttp.routes');
  const calls = [];
  const app = express(); app.use(express.json());
  app.use('/x', createDualStaffPurchaseRouter({ staffService: {}, artifactService: { replacePurchaseArtifact: async () => { calls.push(1); return {}; } }, db: {} }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    runtime.__setReadinessForTest(ALL_READY);
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/x/artifact-replace', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ role: 'staff', name: '가짜 직원' }, process.env.JWT_SECRET) },
      body: JSON.stringify({ orderSubmissionId: orderId, channel: 'naver', expectedArtifactId: orderId, expectedRevision: 1, imageBase64: 'QUFB' }) });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.code, DUAL_PHASE1_MANUAL);
    assert.equal(calls.length, 0, 'service never called');
  } finally { runtime.__setReadinessForTest({}); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('review file move / revert / manual duplicate removal / auto-route mark refuse dual files without touching Drive', async () => {
  const fileRoute = require('../src/services/fileRoute.service');
  const drive = require('../src/services/drive.service');
  const keep = { mut: review.withReviewFilesMutation, drive: { ...drive } };
  const driveCalls = [];
  for (const k of Object.keys(drive)) if (typeof drive[k] === 'function') drive[k] = async () => { driveCalls.push(k); return {}; };
  const sqlCalls = [];
  const client = { query: async sql => { sqlCalls.push(String(sql)); return { rows: [], rowCount: 0 }; } };
  fileRoute.__setPoolForTest({ query: async () => ({ rows: [] }) });
  review.withReviewFilesMutation = async ({ run }) => run(client, { dual: true, submissions: [{ file_id: 'FILEID12345', order_submission_id: orderId }] });
  try {
    for (const [name, call] of [['manualRoute', () => fileRoute.manualRoute({ fileId: 'FILEID12345', target: 'receipt', by: 't' })],
      ['revertRoute', () => fileRoute.revertRoute({ fileId: 'FILEID12345', by: 't' })],
      ['dedupManual', () => fileRoute.dedupManual({ fileId: 'FILEID12345', by: 't' })],
      ['markRouted', () => fileRoute.markRouted({ fileId: 'FILEID12345', by: 't' })]]) {
      const out = await call();
      assert.equal(out.ok, false, name);
      assert.equal(out.error, DUAL_PHASE1_MANUAL, name);
    }
    assert.deepEqual(driveCalls, []);
    assert.equal(sqlCalls.filter(s => /^\s*(UPDATE|INSERT|DELETE)/i.test(s)).length, 0);
  } finally {
    review.withReviewFilesMutation = keep.mut; Object.assign(drive, keep.drive); fileRoute.__setPoolForTest(null);
  }
});

test('automatic duplicate removal skips dual files; staff review-photo replace refuses dual orders', async () => {
  const dup = require('../src/services/reviewDuplicateAuto.service');
  const replace = require('../src/services/reviewCaptureReplace.service');
  const drive = require('../src/services/drive.service');
  const keep = { ctx: review.fileMutationContext, target: review.bundleTargetForRow, drive: { ...drive } };
  const driveCalls = [];
  for (const k of Object.keys(drive)) if (typeof drive[k] === 'function') drive[k] = async () => { driveCalls.push(k); return {}; };
  review.fileMutationContext = async () => ({ dual: true, targets: [{ orderSubmissionId: orderId }], submissions: [{ file_id: 'FILEID12345', order_submission_id: orderId, slot_key: 'review', evidence_revision: 1 }] });
  review.bundleTargetForRow = async (_db, t) => ({ ...t, orderSubmissionId: orderId });
  const writes = [];
  const pool = { query: async (sql) => {
    const q = String(sql); if (/^\s*(UPDATE|INSERT|DELETE)/i.test(q)) writes.push(q);
    if (/FROM campaign_participants/.test(q)) return { rows: [{ id: 'r1', seq: 2, reviewer_name: '가', recipient_name: '가', order_submission_id: orderId }] };
    if (/FROM review_submissions/.test(q)) return { rows: [{ file_id: 'FILEID12345', at: null }] };
    return { rows: [] };
  }, connect: async () => ({ query: pool.query, release() {} }) };
  try {
    dup.__setDepsForTest({ pool, drive });
    if (replace.__setPoolForTest) replace.__setPoolForTest(pool);
    const removed = await dup.__test._removeOne({ fileId: 'FILEID12345', matchFileId: 'FILEID67890', by: 't' });
    assert.equal(removed.ok, false); assert.equal(removed.reason, DUAL_PHASE1_MANUAL);
    const replaced = await replace.replaceReviewCapture({ sheetId: 's', tabName: 't', rowId: 'r1', oldFileId: 'FILEID12345', imageBase64: Buffer.from('fake-image-bytes').toString('base64'), mimeType: 'image/png', by: 't' });
    assert.equal(replaced.ok, false); assert.equal(replaced.error, DUAL_PHASE1_MANUAL);
    assert.deepEqual(driveCalls, []); assert.deepEqual(writes, []);
  } finally {
    review.fileMutationContext = keep.ctx; review.bundleTargetForRow = keep.target; Object.assign(drive, keep.drive);
    dup.__setDepsForTest({}); if (replace.__setPoolForTest) replace.__setPoolForTest(null);
  }
});
