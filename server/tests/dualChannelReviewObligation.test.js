'use strict';
// Single-connection PGlite check (not a PostgreSQL concurrency claim).
// Dual-channel review completion must settle the reviewer participation obligation exactly like the
// legacy web completion (submit.routes): otherwise payment targets keep excluding the finished row
// because reviewer_participations.review_obligation_status stays 'pending'.
process.env.JWT_SECRET = process.env.JWT_SECRET || require('node:crypto').randomBytes(48).toString('hex');
require('./helpers/dualChannelDependencies.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const review = require('../src/services/dualChannelReview.service');

const OS = '11111111-1111-4111-8111-111111111111';
const CP = '22222222-2222-4222-8222-222222222222';
const RPID = '33333333-3333-4333-8333-333333333333';
const OTHER_RPID = '44444444-4444-4444-8444-444444444444';
const SNAP = { channels: { naver: {}, coupang: {} } };

async function fixture({ indexToken = RPID } = {}) {
  const sql = new PGlite();
  await sql.exec(`
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, purchase_bundle_version int, purchase_condition_snapshot jsonb, deleted_at timestamptz);
    CREATE TABLE order_purchase_channels(order_submission_id uuid, channel text);
    CREATE TABLE purchase_capture_artifacts(order_submission_id uuid, status text, superseded_at timestamptz, channel text, role text);
    CREATE TABLE review_submissions(id serial PRIMARY KEY, order_submission_id uuid, purchase_channel text, evidence_role text, evidence_revision int,
      superseded_at timestamptz, slot_key text, completed_at timestamptz, file_id text, file_url text, file_name text, byte_sha256 text, condition_snapshot_hash text);
    CREATE TABLE review_inspections(file_id text, status text, resolution text, checks jsonb);
    CREATE TABLE campaign_participants(id uuid PRIMARY KEY, order_submission_id uuid, active boolean, deleted_at timestamptz, sheet_id text, tab_name text,
      seq int, is_submitted boolean, review_participation_id uuid);
    CREATE TABLE review_index(sheet_id text, tab_name text, row_index int, is_submitted boolean, review_file_id text, review_file_url text, review_file_name text, review_file_count int);
    CREATE TABLE reviewer_participations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_participant_id uuid, lifecycle_status text,
      review_obligation_status text, review_evidence jsonb NOT NULL DEFAULT '{}', index_snapshot jsonb NOT NULL DEFAULT '{}',
      record_version bigint NOT NULL DEFAULT 1, updated_at timestamptz);`);
  await sql.query('INSERT INTO order_submissions VALUES($1,1,$2::jsonb,NULL)', [OS, JSON.stringify(SNAP)]);
  await sql.query(`INSERT INTO campaign_participants VALUES($1,$2,TRUE,NULL,'wt_x','탭',2,FALSE,$3)`, [CP, OS, RPID]);
  await sql.query(`INSERT INTO review_index VALUES('wt_x','탭',2,FALSE,NULL,NULL,NULL,0)`);
  await sql.query(`INSERT INTO reviewer_participations(campaign_participant_id,lifecycle_status,review_obligation_status,index_snapshot) VALUES($1,'active','pending',$2::jsonb)`,
    [CP, JSON.stringify({ _review_participation_id: indexToken })]);
  // a cancelled old participation on the same seat must never be touched
  await sql.query(`INSERT INTO reviewer_participations(campaign_participant_id,lifecycle_status,review_obligation_status,index_snapshot) VALUES($1,'cancelled','pending',$2::jsonb)`,
    [CP, JSON.stringify({ _review_participation_id: RPID })]);
  const db = { query: (text, params) => sql.query(text, params) };
  return { sql, db };
}
async function addReview(sql, channel, slotKey, n) {
  await sql.query(`INSERT INTO review_submissions(order_submission_id,purchase_channel,evidence_role,evidence_revision,slot_key,completed_at,file_id,byte_sha256,condition_snapshot_hash)
    VALUES($1,$2,'review',1,$3,NOW(),$4,$5,$6)`, [OS, channel, slotKey, 'f' + n, String(n).repeat(64).slice(0, 64), review.digest(SNAP)]);
}
const statuses = async sql => (await sql.query(`SELECT lifecycle_status,review_obligation_status,review_evidence FROM reviewer_participations ORDER BY lifecycle_status`)).rows;

test('both channel reviews complete -> active participation fulfilled (legacy web completion parity)', async () => {
  const { sql, db } = await fixture();
  await addReview(sql, 'naver', 'review', 1);
  await addReview(sql, 'coupang', 'slot2', 2);
  const state = await review.recomputeBundleReviewStateInTx(db, OS);
  assert.equal(state.complete, true);
  const rows = await statuses(sql);
  assert.deepEqual(rows.map(r => [r.lifecycle_status, r.review_obligation_status]), [['active', 'fulfilled'], ['cancelled', 'pending']]);
  assert.equal(rows[0].review_evidence.web_submission, RPID);
  assert.equal((await sql.query('SELECT is_submitted FROM review_index')).rows[0].is_submitted, true);
});

test('only one channel review -> obligation stays pending', async () => {
  const { sql, db } = await fixture();
  await addReview(sql, 'naver', 'review', 1);
  const state = await review.recomputeBundleReviewStateInTx(db, OS);
  assert.equal(state.complete, false);
  assert.equal((await statuses(sql))[0].review_obligation_status, 'pending');
});

test('evidence removed after completion -> web-fulfilled obligation returns to pending', async () => {
  const { sql, db } = await fixture();
  await addReview(sql, 'naver', 'review', 1);
  await addReview(sql, 'coupang', 'slot2', 2);
  await review.recomputeBundleReviewStateInTx(db, OS);
  await sql.query(`UPDATE review_submissions SET superseded_at=NOW() WHERE file_id='f2'`);
  const state = await review.recomputeBundleReviewStateInTx(db, OS);
  assert.equal(state.complete, false);
  assert.equal((await statuses(sql))[0].review_obligation_status, 'pending');
});

test('participation token from another assignment is never fulfilled', async () => {
  const { sql, db } = await fixture({ indexToken: OTHER_RPID });
  await addReview(sql, 'naver', 'review', 1);
  await addReview(sql, 'coupang', 'slot2', 2);
  await review.recomputeBundleReviewStateInTx(db, OS);
  assert.equal((await statuses(sql))[0].review_obligation_status, 'pending');
});

// The real migration (032) has no default for review_submissions.uploaded_at, and the inspection sweep only
// picks up rows with uploaded_at inside its window: a NULL here means dual receipts are never inspected and a
// receipt-required order can never become payable.
test('dual review upload stamps uploaded_at (inspection sweep window) like the legacy upload', async () => {
  const { fixture, id, owner } = require('./helpers/dualChannelRealFixture');
  const lifecycle = require('../src/services/dualChannelLifecycle.service');
  const db = await fixture();
  try {
    await db.query('ALTER TABLE review_submissions ALTER COLUMN uploaded_at DROP DEFAULT');
    const files = new Map(); let n = 0;
    const svc = review.createService({ db, lifecycle, drive: { upload: async bytes => { const f = 'u-' + (++n); files.set(f, bytes); return f; }, read: async f => files.get(f) }, authorizeTarget: async () => true });
    const r = await svc.stageReviewUpload({ body: { orderSubmissionId: id, sheetId: 's', tabName: 't', rowIndex: 2, slotKey: 'review', imageBase64: Buffer.from('photo-u').toString('base64'), expectedRevision: 0 }, reviewerSession: { ownerReviewerId: owner } });
    const row = (await db.query('SELECT uploaded_at FROM review_submissions WHERE file_id=$1', [r.fileId])).rows[0];
    assert.ok(row.uploaded_at, 'uploaded_at must be set');
  } finally { await db.end?.(); }
});

// Sheetless boards rebuild review_index.is_submitted from the worktable status cell (sheetlessLedger), so the
// completion must write that cell exactly like the legacy web completion, or the next order in the same tab
// silently reverts the finished review and drops it from payment targets.
test('completion writes the worktable submit cell once on transition; failure aborts; incomplete never writes', async () => {
  const status = require('../src/services/sheetlessStatus.service');
  const orig = status.markStatusCell; const calls = [];
  let reply = { handled: true, ok: true };
  status.markStatusCell = async a => { calls.push(a); return reply; };
  try {
    { const { sql, db } = await fixture(); await addReview(sql, 'naver', 'review', 1);
      await review.recomputeBundleReviewStateInTx(db, OS); assert.equal(calls.length, 0); }
    { const { sql, db } = await fixture(); await addReview(sql, 'naver', 'review', 1); await addReview(sql, 'coupang', 'slot2', 2);
      await review.recomputeBundleReviewStateInTx(db, OS);
      assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'submit'); assert.equal(calls[0].rowIndex, 2); assert.equal(calls[0].client, db);
      await review.recomputeBundleReviewStateInTx(db, OS); assert.equal(calls.length, 1, 'already submitted seat is not rewritten');
    }
    { const { sql, db } = await fixture(); await addReview(sql, 'naver', 'review', 1); await addReview(sql, 'coupang', 'slot2', 2);
      reply = { handled: true, ok: false, reason: 'no_status_column' };
      await assert.rejects(review.recomputeBundleReviewStateInTx(db, OS), e => e.code === 'review_board_write_failed'); }
  } finally { status.markStatusCell = orig; }
});
