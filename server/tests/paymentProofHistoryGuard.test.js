'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const proof = require('../src/services/paymentProof.service');
const { recordDeposits } = require('../src/services/paymentApply.service');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function dbWithSchema() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE payment_batches(id text PRIMARY KEY, historical_key text, status text);
    CREATE TABLE payment_result_uploads(id text PRIMARY KEY, batch_id text, file_format text, file_sha256 text, file_blob bytea, applied boolean DEFAULT false);
    CREATE TABLE payment_batch_items(id text PRIMARY KEY, batch_id text, status text, result_seq integer);
    CREATE TABLE unconfirmed_transfer_reviews(upload_id text, result_seq integer);
    CREATE TABLE payment_account_mismatch_reconciliations(upload_id text, result_seq integer);
    CREATE TABLE payment_amount_mismatch_reconciliations(upload_id text, result_seq integer);
    CREATE TABLE payment_records(source_key text);
  `);
  return db;
}

(async () => {
  const db = await dbWithSchema();
  try {
    const bytes = Buffer.from('masked synthetic transfer evidence');
    const digest = sha(bytes);
    await db.query('INSERT INTO payment_batches VALUES ($1,NULL,$2),($3,NULL,$2),($4,$5,$2)',
      ['normal-a','ready','normal-b','history','historical-fee:synthetic']);
    await db.query('INSERT INTO payment_result_uploads(id,batch_id,file_sha256,file_blob,applied) VALUES ($1,$2,NULL,$3,false),($4,$5,$6,$3,true),($7,$8,$6,$3,true)',
      ['legacy','normal-a',bytes,'upload-a','normal-a',digest,'upload-b','normal-b']);
    await db.query("INSERT INTO payment_result_uploads(id,batch_id,file_format,file_sha256,file_blob,applied) VALUES ('bank-upload','normal-a','bank',NULL,NULL,true)");
    const legacy = await proof.lockUploadProof(db, { uploadId: 'legacy', batchId: 'normal-a' });
    assert.equal(legacy.sha, digest, 'legacy evidence derives its SHA from the stored bytes');
    await proof.lockFileProof(db, digest);
    await proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 });

    await db.query('INSERT INTO unconfirmed_transfer_reviews VALUES ($1, $2)', ['upload-b', 3]);
    await assert.rejects(proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 }), e => e.code === 'proof_already_used');
    await db.query('DELETE FROM unconfirmed_transfer_reviews');
    await db.query('INSERT INTO payment_account_mismatch_reconciliations VALUES ($1,$2)', ['upload-b', 3]);
    await assert.rejects(proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 }), e => e.code === 'proof_already_used');
    await db.query('DELETE FROM payment_account_mismatch_reconciliations');
    await db.query('INSERT INTO payment_amount_mismatch_reconciliations VALUES ($1,$2)', ['upload-b', 3]);
    await assert.rejects(proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 }), e => e.code === 'proof_already_used');
    await db.query('DELETE FROM payment_amount_mismatch_reconciliations');

    const otherDigest = sha('different synthetic result file');
    await db.query('UPDATE payment_result_uploads SET file_sha256=$1,file_blob=$2 WHERE id=$3',
      [otherDigest, Buffer.from('different synthetic result file'), 'upload-b']);
    await db.query("INSERT INTO payment_batch_items VALUES ('item-a','normal-a','paid',3),('item-b','normal-b','paid',3)");
    await assert.rejects(proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 }), e => e.code === 'proof_already_used');
    await proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 4 });
    await db.query("DELETE FROM payment_batch_items WHERE id='item-a'");
    await proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 });

    await db.query("INSERT INTO payment_result_uploads(id,batch_id,file_format,file_sha256,file_blob,applied) VALUES ('unrelated-prearchive','normal-a','xlsx',NULL,NULL,true)");
    await proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 4 });
    await db.query("DELETE FROM payment_result_uploads WHERE id='unrelated-prearchive'");
    await db.query('INSERT INTO payment_records VALUES ($1)', [`historical-fee:${digest}:3`]);
    await assert.rejects(proof.assertProofUnused(db, { sha: digest, uploadId: 'legacy', resultSeq: 3 }), e => e.code === 'proof_already_used');

    await db.query('UPDATE payment_result_uploads SET file_sha256=$1 WHERE id=$2', ['bad-sha', 'legacy']);
    await assert.rejects(proof.lockUploadProof(db, { uploadId: 'legacy', batchId: 'normal-a' }), e => e.code === 'invalid_evidence');
    await db.query('UPDATE payment_result_uploads SET file_sha256=NULL,file_blob=NULL WHERE id=$1', ['legacy']);
    await assert.rejects(proof.lockUploadProof(db, { uploadId: 'legacy', batchId: 'normal-a' }), e => e.code === 'invalid_evidence');

    assert.equal(proof.isHistoryOnlyKey('historical-fee:synthetic'), true);
    assert.equal(proof.isHistoryOnlyKey('historical-fee:'), true);
    assert.equal(proof.isHistoryOnlyKey('manual-811'), false);
    await assert.rejects(proof.assertBatchNotHistoryOnly(db, 'history'), e => e.code === 'history_only');
    await proof.assertBatchNotHistoryOnly(db, 'normal-a');
    const ledgerWrites = [];
    await recordDeposits({ query: async (sql, params) => { ledgerWrites.push({ sql: String(sql), params }); return { rowCount: 1 }; } }, [{
      sheetId: 'synthetic-sheet', tabName: 'synthetic-tab', rowIndex: 1, feeOnly: true,
      amount: '100', sourceKey: `historical-fee:${digest}:5`,
    }]);
    assert.match(ledgerWrites[0].sql, /source_key/);
    assert.equal(ledgerWrites[0].params[7], `historical-fee:${digest}:5`);
    console.log('paymentProofHistoryGuard: PASS');
  } finally { await db.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
