/**
 * paymentExternalWork.service — 「리뷰웹 밖 작업」 이체 표시(결정 317 · 사용자 확정 2026-11-02 방식 B).
 *
 * 블로그·예약자리뷰처럼 리뷰웹에 없는 작업은 직원이 내려받은 케이뱅크 엑셀에 직접 줄을 넣어 같은 대량이체로 보낸다.
 * 결과 파일을 놓으면 그 줄은 '미확인 이체'로 남는다 → 담당자가 작업명을 붙여 표시하면 미확인에서 빠진다.
 *
 * ★ 분류 기록일 뿐이다 — 입금 기록(payment_records·작업보드 입금칸)·회차 항목은 건드리지 않는다.
 * ★ 같은 결과 줄은 한 번만 쓴다 — 표시 전에 `paymentProof.assertProofRowsUnused`(작업 대조 승인·계좌/금액 불일치 반영·
 *   지급과 같은 검사)를 통과해야 하고, 표시된 줄은 그 검사에 잡혀 이후 승인에 쓰이지 않는다(paymentProof 의 external 검사).
 * ★ 키 = 파일 내용(sha256)+결과 줄 번호 — 같은 파일을 다시 놓아도 표시가 유지된다.
 * ★ 이름·계좌는 결과 파일에 이미 있는 값(미확인 미리보기와 같은 수준: 예금주 · 계좌 끝 4자리)만 남긴다.
 */
'use strict';
const { logger } = require('../utils/logger');
const paymentProof = require('./paymentProof.service');
const { loadSheetAoa } = require('../utils/spreadsheetLoad');
const { parseResultAoa } = require('../utils/paymentResultParse');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

class ExternalWorkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const MAX_ROWS = 500;
const _txt = (v, n = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 미확인 줄을 「리뷰웹 밖 작업」으로 표시한다.
 * @param {{batchId:string, uploadId:string, seqs:number[], workName:string, by?:string}} p
 * @returns {{ok:true, marked:number, workName:string}}
 */
async function markExternalWork({ batchId, uploadId, seqs, workName, by }) {
  const name = _txt(workName, 120);
  const list = [...new Set((Array.isArray(seqs) ? seqs : []).map(Number))];
  if (!batchId || !uploadId) throw new ExternalWorkError('bad_request', '대량이체와 결과 파일을 확인해 주세요.');
  if (!name) throw new ExternalWorkError('bad_request', '작업명을 적어 주세요(구글시트의 작업명을 그대로 쓰면 나중에 찾기 쉽습니다).');
  if (!list.length || list.length > MAX_ROWS || list.some(n => !Number.isInteger(n) || n < 0)) {
    throw new ExternalWorkError('bad_request', '표시할 줄을 골라 주세요.');
  }
  const client = await _db().connect();
  try {
    await client.query('BEGIN');
    await paymentProof.assertBatchNotHistoryOnly(client, batchId);
    const proof = await paymentProof.lockUploadProof(client, { uploadId, batchId });
    await paymentProof.lockFileProof(client, proof.sha);
    // 이미 승인·반영·지급에 쓰였거나 이미 리뷰웹 밖으로 표시한 줄이면 거부(같은 줄 두 번 쓰기 금지)
    await paymentProof.assertProofRowsUnused(client, { sha: proof.sha, uploadId, resultSeqs: list });
    const { rows: [up] } = await client.query(
      `SELECT u.id, u.bank, u.file_name, u.file_blob, u.summary, b.status AS batch_status
         FROM payment_result_uploads u JOIN payment_batches b ON b.id = u.batch_id
        WHERE u.id = $1 AND u.batch_id = $2`, [uploadId, batchId]);
    if (!up) throw new ExternalWorkError('not_found', '결과 파일을 찾을 수 없습니다.');
    if (up.batch_status === 'cancelled') throw new ExternalWorkError('cancelled', '취소된 대량이체입니다.');
    const outside = up.summary && up.summary.preview && up.summary.preview.unmatchedResults;
    const outsideSeqs = new Set((Array.isArray(outside) ? outside : []).map(x => Number(x && x.seq)));
    const notOutside = list.filter(n => !outsideSeqs.has(n));
    if (notOutside.length) {
      throw new ExternalWorkError('not_unmatched', '대량이체에 있는 사람과 맞춰진 줄은 리뷰웹 밖 작업으로 표시할 수 없습니다. 화면을 새로고침해 주세요.');
    }
    const loaded = loadSheetAoa(Buffer.from(up.file_blob), up.file_name || '');
    const parsed = loaded && loaded.ok && parseResultAoa(loaded.aoa, { expectBank: up.bank });
    if (!parsed || !parsed.ok) throw new ExternalWorkError('invalid_evidence', '결과 파일 원본을 읽지 못해 표시할 수 없습니다.');
    const bySeq = new Map(parsed.rows.map(r => [Number(r.seq), r]));
    let marked = 0;
    for (const seq of list) {
      const r = bySeq.get(seq);
      if (!r) throw new ExternalWorkError('not_found', '결과 파일에 없는 줄입니다. 화면을 새로고침해 주세요.');
      const { rowCount } = await client.query(
        `INSERT INTO external_work_transfers
           (file_sha256, result_seq, batch_id, upload_id, bank, work_name, amount, success, holder, account_tail, memo, transferred_at, marked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (file_sha256, result_seq) DO NOTHING`,
        [proof.sha, seq, batchId, uploadId, up.bank || '', name, Number(r.amount) || 0, !!r.success,
          _txt(r.holder, 60), String(r.accountDigits || '').slice(-4), _txt(r.memo, 60), r.transferredAtIso || null, _txt(by, 100)]);
      marked += rowCount;
    }
    await client.query('COMMIT');
    return { ok: true, marked, workName: name };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 원래 오류를 올린다 */ }
    throw e;
  } finally { client.release(); }
}

/** 표시 되돌리기 — 그 줄은 다시 '미확인'으로 돌아간다(입금 기록은 처음부터 없었다). */
async function unmarkExternalWork({ id, by }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new ExternalWorkError('bad_request', '되돌릴 줄을 확인해 주세요.');
  const client = await _db().connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query('SELECT file_sha256 FROM external_work_transfers WHERE id = $1', [id]);
    if (!row) throw new ExternalWorkError('not_found', '이미 되돌렸거나 없는 표시입니다.');
    await paymentProof.lockFileProof(client, row.file_sha256);
    const { rows: [gone] } = await client.query(
      'DELETE FROM external_work_transfers WHERE id = $1 RETURNING work_name, amount, result_seq', [id]);
    await client.query('COMMIT');
    if (gone) logger.info(`[ExternalWork] 표시 되돌림 by=${_txt(by, 60)} work=${gone.work_name} seq=${gone.result_seq} amount=${gone.amount}`);
    return { ok: true, undone: gone ? 1 : 0 };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 원래 오류를 올린다 */ }
    throw e;
  } finally { client.release(); }
}

/** 이 결과 파일(같은 내용 전부)에서 리뷰웹 밖 작업으로 표시한 줄 — 미확인 창 아래 「표시한 줄」·되돌리기용. */
async function listForUpload(uploadId, db = _db()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(uploadId || ''))) return [];
  const { rows } = await db.query(
    `SELECT e.id, e.result_seq AS seq, e.work_name AS "workName", e.amount, e.holder, e.account_tail AS "accountTail",
            e.memo, e.transferred_at AS "transferredAt", e.marked_by AS "markedBy", e.marked_at AS "markedAt"
       FROM external_work_transfers e
       JOIN payment_result_uploads u ON u.file_sha256 = e.file_sha256
      WHERE u.id = $1
      ORDER BY e.result_seq`, [uploadId]);
  return rows;
}

/** 표시된 결과 줄 번호(같은 파일 내용 기준) — 미확인 목록·건수에서 뺄 때. */
async function markedSeqsForUpload(uploadId, db = _db()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(uploadId || ''))) return new Set();
  const { rows } = await db.query(
    `SELECT e.result_seq FROM external_work_transfers e
       JOIN payment_result_uploads u ON u.file_sha256 = e.file_sha256
      WHERE u.id = $1`, [uploadId]);
  return new Set(rows.map(r => Number(r.result_seq)));
}

/** 최근 쓴 작업명(입력 자동완성) */
async function recentWorkNames(limit = 30) {
  const { rows } = await _db().query(
    `SELECT work_name, MAX(marked_at) AS last FROM external_work_transfers
      GROUP BY work_name ORDER BY last DESC LIMIT $1`, [Math.min(100, Math.max(1, Number(limit) || 30))]);
  return rows.map(r => r.work_name);
}

/** 통장 「기록 없이 나간 돈」 계산용 — 그 은행에서 리뷰웹 밖 작업으로 표시된 성공 이체(시각·금액). */
async function paidTransfersForBank(bank, fromIso, db = _db()) {
  const { rows } = await db.query(
    `SELECT (EXTRACT(EPOCH FROM transferred_at) * 1000)::bigint AS at, amount
       FROM external_work_transfers
      WHERE bank = $1 AND success = TRUE AND transferred_at IS NOT NULL AND transferred_at >= $2`, [bank, fromIso]);
  return rows.map(r => ({ at: Number(r.at), amount: Number(r.amount) }));
}

module.exports = {
  markExternalWork, unmarkExternalWork, listForUpload, markedSeqsForUpload, recentWorkNames, paidTransfersForBank,
  ExternalWorkError, __setPoolForTest,
};
