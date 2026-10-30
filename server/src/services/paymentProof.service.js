'use strict';

const crypto = require('node:crypto');

function proofError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isHistoryOnlyKey(value) {
  return String(value || '').startsWith('historical-fee:');
}

function sha256(blob) {
  return crypto.createHash('sha256').update(blob).digest('hex');
}

/** Read and validate evidence without taking a source-batch lock. */
async function lockUploadProof(db, { uploadId, batchId } = {}) {
  const params = batchId ? [uploadId, batchId] : [uploadId];
  const { rows: [upload] } = await db.query(
    `SELECT id, batch_id, file_blob, file_sha256
       FROM payment_result_uploads WHERE id = $1${batchId ? ' AND batch_id = $2' : ''}`,
    params);
  if (!upload) throw proofError('invalid_evidence', '결과 파일 증거를 찾을 수 없습니다.');
  if (!upload.file_blob) throw proofError('invalid_evidence', '결과 파일의 원본 증거를 확인할 수 없습니다.');
  const blob = Buffer.isBuffer(upload.file_blob) ? upload.file_blob : Buffer.from(upload.file_blob);
  const actualSha = sha256(blob);
  if (upload.file_sha256 && String(upload.file_sha256).toLowerCase() !== actualSha) {
    throw proofError('invalid_evidence', '결과 파일 증거의 무결성을 확인할 수 없습니다.');
  }
  return { sha: actualSha, uploadId: upload.id, batchId: upload.batch_id };
}

/** Same advisory-lock namespace as the existing duplicate-file guard. */
async function lockFileProof(db, sha) {
  if (!/^[a-f0-9]{64}$/i.test(String(sha || ''))) {
    throw proofError('invalid_evidence', '결과 파일 증거의 지문을 확인할 수 없습니다.');
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(sha).toLowerCase()]);
}

/**
 * Fail closed if this exact file row has already reserved or consumed payment.
 * Lock order contract: callers lock/validate this proof before locking any batch.
 */
async function assertProofRowsUnused(db, { sha, uploadId, resultSeqs } = {}) {
  const normalizedSha = String(sha || '').toLowerCase();
  const seqs = [...new Set((resultSeqs || []).map(Number))];
  if (!/^[a-f0-9]{64}$/.test(normalizedSha) || seqs.some(seq=>!Number.isInteger(seq) || seq<0)) {
    throw proofError('invalid_evidence', '결과 파일 행의 증거를 확인할 수 없습니다.');
  }
  if (!seqs.length) return true;
  // Load/hash each archive ONCE for this transaction's entire requested set.
  // Unknown, unrelated pre-archive rows are not falsely identified as this file.
  const { rows: candidates } = await db.query(
    `SELECT id, batch_id, file_format, file_blob, file_sha256, applied
       FROM payment_result_uploads
      WHERE COALESCE(file_format, '') <> 'bank'
        AND (file_sha256 = $1 OR (file_sha256 IS NULL AND file_blob IS NOT NULL))`, [normalizedSha]);
  const sameFileUploads = [];
  for (const row of candidates) {
    if (!row.file_blob) throw proofError('invalid_evidence', '이전 결과 파일의 원본 증거를 확인할 수 없습니다.');
    const actualSha = sha256(Buffer.isBuffer(row.file_blob) ? row.file_blob : Buffer.from(row.file_blob));
    if (row.file_sha256 && String(row.file_sha256).toLowerCase() !== actualSha) {
      throw proofError('invalid_evidence', '이전 결과 파일 증거의 무결성을 확인할 수 없습니다.');
    }
    if (actualSha === normalizedSha) sameFileUploads.push(row);
  }
  if (uploadId && !sameFileUploads.some(row => String(row.id) === String(uploadId))) {
    throw proofError('invalid_evidence', '선택한 결과 파일과 행의 증거가 일치하지 않습니다.');
  }
  const ids = sameFileUploads.map(row => row.id);
  const used = () => proofError('proof_already_used', '같은 이체 결과 행이 이미 처리되어 다시 사용할 수 없습니다.');
  const checks = [
    `SELECT 1 FROM unconfirmed_transfer_reviews WHERE upload_id::text = ANY($1::text[]) AND result_seq = ANY($2::int[]) LIMIT 1`,
    `SELECT 1 FROM payment_account_mismatch_reconciliations WHERE upload_id::text = ANY($1::text[]) AND result_seq = ANY($2::int[]) LIMIT 1`,
    `SELECT 1 FROM payment_amount_mismatch_reconciliations WHERE upload_id::text = ANY($1::text[]) AND result_seq = ANY($2::int[]) LIMIT 1`,
  ];
  for (const sql of checks) {
    const { rows } = await db.query(sql, [ids, seqs]);
    if (rows.length) throw used();
  }
  const { rows: paid } = await db.query(
    `SELECT DISTINCT i.result_seq, i.bank_account, i.amount, i.paid_at
       FROM payment_result_uploads u
       JOIN payment_batches b ON b.id = u.batch_id
       JOIN payment_batch_items i ON i.batch_id = u.batch_id AND i.result_seq = ANY($2::int[]) AND i.status = 'paid'
      WHERE u.id::text = ANY($1::text[]) AND u.applied = TRUE
        AND COALESCE(u.file_format, '') <> 'bank'
        AND COALESCE(b.historical_key, '') NOT LIKE 'historical-fee:%'`, [ids, seqs]);
  if (paid.length) {
    // A batch may have MANY different result files whose seq starts at 1.
    // Attribute a paid item to this exact file row only by the real parsed
    // account+amount+transfer timestamp, never batch+seq alone (PR #1727 P2).
    const { loadSheetAoa } = require('../utils/spreadsheetLoad');
    const { parseResultAoa, digitsOnly } = require('../utils/paymentResultParse');
    const loaded = loadSheetAoa(Buffer.from(sameFileUploads[0].file_blob), '');
    const parsed = loaded.ok && parseResultAoa(loaded.aoa);
    if (!parsed || !parsed.ok) throw proofError('invalid_evidence', '실제 지급 근거 파일을 해석할 수 없습니다.');
    const bySeq = new Map(parsed.rows.map(r=>[Number(r.seq),r]));
    for (const item of paid) {
      const result = bySeq.get(Number(item.result_seq));
      if (!result || !result.success) continue;
      if (digitsOnly(item.bank_account)!==result.accountDigits || Number(item.amount)!==Number(result.amount)) continue;
      // Missing bank time cannot prove a distinct transfer: hold rather than
      // manufacture an association or allow the same account/amount twice.
      if (!result.transferredAtIso || !item.paid_at ||
          new Date(item.paid_at).getTime()!==new Date(result.transferredAtIso).getTime()) {
        throw proofError('invalid_evidence', '같은 계좌·금액의 지급 기록과 이체시각이 달라 어느 파일의 지급인지 확정할 수 없습니다. 원본 증거를 확인해 주세요.');
      }
      throw used();
    }
  }
  const { rows: records } = await db.query(
    `SELECT 1 FROM payment_records WHERE source_key = ANY($1::text[]) LIMIT 1`,
    [seqs.map(seq=>`historical-fee:${normalizedSha}:${seq}`)]);
  if (records.length) throw used();
  return true;
}
async function assertProofUnused(db, { sha, uploadId, resultSeq } = {}) {
  return assertProofRowsUnused(db, {sha,uploadId,resultSeqs:[resultSeq]});
}

async function assertBatchNotHistoryOnly(db, batchId) {
  const { rows: [batch] } = await db.query(
    'SELECT historical_key FROM payment_batches WHERE id = $1', [batchId]);
  if (batch && isHistoryOnlyKey(batch.historical_key)) {
    throw proofError('history_only', '과거 입금 기록은 이체 파일을 만들거나 결과를 반영할 수 없습니다.');
  }
  return batch;
}

module.exports = { isHistoryOnlyKey, lockUploadProof, lockFileProof, assertProofUnused, assertProofRowsUnused, assertBatchNotHistoryOnly };
