'use strict';

if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — 폐기용 PostgreSQL 세션 검증 건너뜀');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const sessions = require('../src/services/purchaseSubmissionSession.service');

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query('DROP TABLE IF EXISTS purchase_submission_sessions, order_submissions CASCADE');
  await pool.query(`CREATE TABLE order_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deleted_at TIMESTAMPTZ,
    capture_file_id TEXT,
    capture_uploaded_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '146_purchase_submission_sessions.sql'), 'utf8');
  await pool.query(migration);
  const { rows } = await pool.query(`INSERT INTO order_submissions DEFAULT VALUES RETURNING id`);
  const orderId = rows[0].id;

  console.log('\n[A] 실제 PostgreSQL 발급·검증');
  let issued;
  await t('마이그레이션이 적용되고 살아 있는 주문에 세션이 발급된다', async () => {
    issued = await sessions.issueForOrder({ orderSubmissionId: orderId, captureSheetId: 'wt-pg', captureTabName: 'PG탭' });
    assert.ok(issued.id && issued.token);
    const db = await pool.query('SELECT token_hash, capture_sheet_id, capture_tab_name FROM purchase_submission_sessions WHERE id=$1', [issued.id]);
    assert.equal(db.rows[0].token_hash, sessions._hash(issued.token));
    assert.equal(db.rows[0].capture_sheet_id, 'wt-pg');
    assert.equal(db.rows[0].capture_tab_name, 'PG탭');
  });
  await t('토큰·주문ID 정확일치만 통과한다', async () => {
    const ok = await sessions.inspectForUpload({ sessionId: issued.id, sessionToken: issued.token, orderSubmissionId: orderId });
    const bad = await sessions.inspectForUpload({ sessionId: issued.id, sessionToken: issued.token + 'x', orderSubmissionId: orderId });
    assert.equal(ok.ok, true); assert.equal(bad.code, 'capture_session_invalid');
  });

  console.log('\n[B] 실제 PostgreSQL 동시 제출');
  await t('같은 세션의 동시 업로드 lease는 한 요청만 획득한다', async () => {
    const lease = await sessions.issueForOrder({ orderSubmissionId: orderId, captureSheetId: 's', captureTabName: 't' });
    const got = await Promise.all([
      sessions.markUploading({ sessionId: lease.id, orderSubmissionId: orderId }),
      sessions.markUploading({ sessionId: lease.id, orderSubmissionId: orderId }),
    ]);
    assert.equal(got.filter(Boolean).length, 1);
  });
  await t('두 세션이 동시에 다른 파일을 연결해도 첫 파일 하나만 남는다', async () => {
    const a = await sessions.issueForOrder({ orderSubmissionId: orderId, captureSheetId: 's', captureTabName: 't' });
    const b = await sessions.issueForOrder({ orderSubmissionId: orderId, captureSheetId: 's', captureTabName: 't' });
    const out = await Promise.all([
      sessions.completeCapture({ sessionId: a.id, sessionToken: a.token, orderSubmissionId: orderId, captureFileId: 'FILE-A' }),
      sessions.completeCapture({ sessionId: b.id, sessionToken: b.token, orderSubmissionId: orderId, captureFileId: 'FILE-B' }),
    ]);
    const saved = await pool.query('SELECT capture_file_id FROM order_submissions WHERE id=$1', [orderId]);
    assert.ok(['FILE-A', 'FILE-B'].includes(saved.rows[0].capture_file_id));
    assert.equal(out.filter(x => x.alreadyCompleted).length, 1);
  });
  await t('완료 뒤 재시도는 기존 파일을 반환하고 덮어쓰지 않는다', async () => {
    const out = await sessions.completeCapture({
      sessionId: issued.id, sessionToken: issued.token, orderSubmissionId: orderId, captureFileId: 'FILE-LATE',
    });
    const saved = await pool.query('SELECT capture_file_id FROM order_submissions WHERE id=$1', [orderId]);
    assert.equal(out.alreadyCompleted, true); assert.notEqual(saved.rows[0].capture_file_id, 'FILE-LATE');
  });

  console.log('\n[C] 만료·삭제 경계');
  await t('만료된 세션은 거부한다', async () => {
    const exp = await sessions.issueForOrder({ orderSubmissionId: orderId });
    await pool.query(`UPDATE purchase_submission_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [exp.id]);
    const out = await sessions.inspectForUpload({ sessionId: exp.id, sessionToken: exp.token, orderSubmissionId: orderId });
    assert.equal(out.code, 'capture_session_invalid');
  });
  await t('삭제된 주문에는 새 세션을 발급하지 않는다', async () => {
    const gone = await pool.query(`INSERT INTO order_submissions(deleted_at) VALUES(NOW()) RETURNING id`);
    await assert.rejects(() => sessions.issueForOrder({ orderSubmissionId: gone.rows[0].id }), /주문을 찾을 수 없습니다/);
  });

  console.log(`\n✅ purchaseSubmissionSessionPg: ${passed}개 통과`);
})().catch(err => { console.error('\n❌ ' + err.stack); process.exitCode = 1; }).finally(async () => {
  try { await pool.query('DROP TABLE IF EXISTS purchase_submission_sessions, order_submissions CASCADE'); } catch (_) {}
  try { await pool.end(); } catch (_) {}
});
