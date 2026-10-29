'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const sessions = require('../src/services/purchaseSubmissionSession.service');
const db = new PGlite();
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  await db.exec(`CREATE TABLE order_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at TIMESTAMPTZ,
    capture_file_id TEXT, capture_uploaded_at TIMESTAMPTZ,
    capture_file_id_2 TEXT, capture2_uploaded_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '146_purchase_submission_sessions.sql'), 'utf8'));
  sessions.__setPoolForTest(db);
  const orderId = (await db.query('INSERT INTO order_submissions DEFAULT VALUES RETURNING id')).rows[0].id;
  const issued = await sessions.issueForOrder({ orderSubmissionId: orderId });
  await t('completed session cannot be reclaimed after a delayed preflight', async () => {
    await db.query("UPDATE order_submissions SET capture_file_id='WINNER' WHERE id=$1", [orderId]);
    await db.query("UPDATE purchase_submission_sessions SET status='completed',capture_file_id='WINNER',completed_at=NOW() WHERE id=$1", [issued.id]);
    const claim = await sessions.markUploading({ sessionId: issued.id, orderSubmissionId: orderId });
    assert.equal(claim, null, 'completed session must not become uploading again');
    const row = (await db.query('SELECT status,attempt_count,capture_file_id FROM purchase_submission_sessions WHERE id=$1', [issued.id])).rows[0];
    assert.equal(row.status, 'completed'); assert.equal(row.attempt_count, 0); assert.equal(row.capture_file_id, 'WINNER');
  });
  await t('late failure cannot change the state owned by a newer upload attempt', async () => {
    const id = (await db.query('INSERT INTO order_submissions DEFAULT VALUES RETURNING id')).rows[0].id;
    const s = await sessions.issueForOrder({ orderSubmissionId: id });
    const args = { sessionId: s.id, orderSubmissionId: id };
    const first = await sessions.markUploading(args);
    assert.deepEqual(first, { attemptCount: 1 });
    assert.equal(await sessions.markUploading(args), null, 'fresh active lease remains exclusive');
    await db.query("UPDATE purchase_submission_sessions SET updated_at=NOW()-INTERVAL '6 minutes' WHERE id=$1", [s.id]);
    const newer = await sessions.markUploading(args);
    assert.deepEqual(newer, { attemptCount: 2 });
    await sessions.markFailed({ ...args, attemptCount: first.attemptCount, code: 'old-request-failed' });
    let row = (await db.query('SELECT status,attempt_count,failure_code FROM purchase_submission_sessions WHERE id=$1', [s.id])).rows[0];
    assert.equal(row.status, 'uploading', 'late failure must not mark the newer lease failed');
    assert.equal(row.failure_code, null); assert.equal(row.attempt_count, 2);
    await sessions.markFailed({ ...args, code: 'no-owned-lease' });
    row = (await db.query('SELECT status FROM purchase_submission_sessions WHERE id=$1', [s.id])).rows[0];
    assert.equal(row.status, 'uploading', 'missing attempt number cannot write');
    await sessions.markFailed({ ...args, attemptCount: newer.attemptCount, code: 'owned-failure' });
    row = (await db.query('SELECT status,failure_code FROM purchase_submission_sessions WHERE id=$1', [s.id])).rows[0];
    assert.equal(row.status, 'failed'); assert.equal(row.failure_code, 'owned-failure');
    assert.deepEqual(await sessions.markUploading(args), { attemptCount: 3 }, 'owned failure remains retryable');
  });
  console.log('purchaseCaptureLease: ' + passed + ' SQL-engine tests passed; no external database');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => { sessions.__setPoolForTest(null); await db.close(); });
