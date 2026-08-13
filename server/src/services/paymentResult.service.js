'use strict';
const crypto = require('crypto');
/**
 * 리뷰비 입금 M2 — 이체결과 파일 반영
 *
 *  흐름 = ① 결과 파일 업로드 → ② 해석(`utils/paymentResultParse`) → ③ 회차 건과 짝 맞추기
 *        → ④ **사람이 확인 화면에서 [이대로 반영]** → ⑤ 성공 건만 입금 기록.
 *
 * ★★ 미리보기(preview)는 입금·실패 상태를 바꾸지 않고, 마스킹된 확인 이력만 남긴다.
 * ★★ 반영은 **서버가 파일을 다시 해석·재매칭**한다 — 화면이 보낸 결과 목록을 믿지 않는다
 *    (낡은 화면·조작 요청이 그대로 "입금완료"가 되면 되돌릴 수 없다).
 * ★★ 입금 기록은 `paymentApply.service` **한 벌**(수동 처리와 같은 함수) —
 *    `review_index PAID` + `payment_records` + 무시트 작업표 칸 / 시트 칸·큐.
 * ★ 입금칸에 찍는 시각은 **결과 파일의 실제 이체시점**(사용자 확정 ④) — '지금'이 아니다.
 *
 * ★★ 멱등·이중입금 방지(완화 금지)
 *   · 처리 대상은 **`pending` 항목뿐**. 이미 `paid` 인 건은 어떤 파일을 다시 올려도 건드리지 않는다
 *     → 같은 파일을 두 번 올려도 두 번 입금되지 않는다.
 *   · 결과 파일에 없는 건은 **`pending` 그대로 둔다**(실패로 내리지 않는다). 실패로 내리면 그 행이
 *     부분유니크에서 빠져 다음 회차에 다시 담기는데, 실제로는 이체가 됐고 파일만 부분적일 수 있어
 *     **이중입금**이 된다. 그래서 "결과 없음"은 화면이 고지하고 사람이 파일을 다시 받아 올린다
 *     (재반영은 열려 있다 — 위의 pending-only 규칙이 그것을 안전하게 만든다).
 *   · 은행이 실패로 답한 건만 `failed` → 부분유니크에서 빠져 **다음 회차에 다시 담긴다**(재이체 경로).
 */

/* ★ 테스트에서 실제 실행이 가능하도록 pool 을 지연 해석한다(레포 관용구 `__setPoolForTest`). */
let _pool;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }
const { logger } = require('../utils/logger');
const { formatDepositStamp } = require('../utils/depositStamp');
const { loadSheetAoa } = require('../utils/spreadsheetLoad');
const { parseResultAoa, matchResults, digitsOnly } = require('../utils/paymentResultParse');
const paymentApply = require('./paymentApply.service');
const { recordDeposits } = paymentApply;
const { rebuildLedgers } = require('./sheetlessLedger.service');

const MAX_BASE64 = 16 * 1024 * 1024;   // base64 는 원본의 약 1.34배 — 12MB 파일까지 수용
const AUTO_APPLY_MATCH_RATE = 0.9;

class ResultError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function decideAutoApply({ summary, duplicateApplied = false }) {
  const s = summary || {};
  const items = Number(s.items) || 0;
  const matched = Number(s.matched) || 0;
  const matchRate = items ? matched / items : 0;
  const blockers = [];
  if (!items) blockers.push('no_pending_items');
  else if (matchRate < AUTO_APPLY_MATCH_RATE) blockers.push('match_below_90');
  if ((Number(s.unmatchedResults) || 0) > 0) blockers.push('result_outside_batch');
  if (duplicateApplied) blockers.push('duplicate_file');
  return { allowed: blockers.length === 0, matchRate, blockers };
}

function _depositDateFromResultStamp(value) {
  const stamp = formatDepositStamp(value);
  return /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(stamp) ? stamp : '';
}

function _depositDateFromPaidAt(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return formatDepositStamp(`${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`);
}

async function _saveBoardWriteOutcome({ batchId, outcome, stamp, by }) {
  await _db().query(
    `UPDATE payment_batches
        SET board_recorded_count = $2,
            board_queued_count = $3,
            board_skipped_count = $4,
            board_failed_count = $5,
            board_stamp = $6,
            board_recorded_at = NOW(),
            board_recorded_by = $7
      WHERE id = $1`,
    [batchId, outcome.recorded, outcome.queued, outcome.skipped, outcome.failed, stamp || '', by || 'payment']);
}

/** DB 행 → 짝맞추기 입력 모양(파서는 DB 컬럼명을 모른다) */
function _itemView(r) {
  return {
    id: r.id,
    sheetId: r.sheet_id, tabName: r.tab_name, rowIndex: r.row_index,
    reviewerName: r.reviewer_name || '', phone8: r.phone8 || '',
    bankName: r.bank_name || '', bankAccount: r.bank_account || '',
    accountHolder: r.account_holder || '',
    amount: Number(r.amount || 0),
    transferMemo: r.transfer_memo || '',
    status: r.status,
  };
}

/** 화면에 내려줄 건 정보 — ★ 계좌는 뒤 4자리만(확인 화면에 전체 계좌를 늘리지 않는다) */
function _pairView(p) {
  const it = p.item;
  return {
    itemId: it.id,
    reviewerName: it.reviewerName,
    tabName: it.tabName,
    rowIndex: it.rowIndex,
    amount: it.amount,
    accountTail: digitsOnly(it.bankAccount).slice(-4),
    bankName: it.bankName,
    holder: it.accountHolder,
    memo: it.transferMemo,
    status: it.status,
    outcome: it.status === 'paid' ? 'already_paid'
           : !p.result ? 'not_in_file'
           : (p.success ? 'success' : 'failed'),
    resultStatus: p.result ? p.result.statusRaw : '',
    transferredAt: p.result ? p.result.transferredStamp : '',
    resultSeq: p.result ? p.result.seq : null,
  };
}

/**
 * 파일을 해석하고 회차 건과 짝을 맞춘다(쓰기 0).
 * @returns {{batch, parse, pairs, view, unmatchedResults, orderAssigned, summary}}
 */
async function _analyze(batchId, fileName, base64) {
  if (!batchId) throw new ResultError('bad_request', '회차를 지정해 주세요.');
  if (!base64) throw new ResultError('bad_request', '파일이 비어 있습니다.');
  if (String(base64).length > MAX_BASE64) throw new ResultError('too_large', '파일이 너무 큽니다(12MB 초과).');

  const { rows: [b] } = await _db().query(`SELECT * FROM payment_batches WHERE id = $1`, [batchId]);
  if (!b) throw new ResultError('not_found', '회차를 찾을 수 없습니다.');
  if (b.status === 'cancelled') throw new ResultError('cancelled', '취소된 회차입니다.');

  let buf;
  try { buf = Buffer.from(String(base64), 'base64'); }
  catch (_) { throw new ResultError('bad_file', '파일을 읽지 못했습니다.'); }

  const loaded = loadSheetAoa(buf, fileName || '');
  if (!loaded.ok) throw new ResultError('bad_file', loaded.error);

  const parse = parseResultAoa(loaded.aoa, { expectBank: b.bank });
  if (!parse.ok) throw new ResultError('parse_failed', parse.error);

  const { rows: itemRows } = await _db().query(
    `SELECT * FROM payment_batch_items WHERE batch_id = $1 ORDER BY created_at, id`, [batchId]);
  const items = itemRows.map(_itemView);

  /* ★ 짝맞추기 대상은 **아직 처리되지 않은 건(pending)** 뿐 —
       이미 paid 인 건을 대상에 넣으면 같은 결과 줄을 두 번 소비해 뒤 건이 "결과 없음"이 된다. */
  const targets = items.filter(it => it.status === 'pending');
  const m = matchResults(targets, parse.rows);

  const donePairs = items.filter(it => it.status !== 'pending')
    .map(it => ({ item: it, result: null, matchKey: '', success: false, reason: 'already' }));

  return {
    batch: b,
    parse,
    format: loaded.format,
    pairs: m.pairs,
    view: [...m.pairs, ...donePairs].map(_pairView),
    unmatchedResults: m.unmatchedResults.map(r => ({
      seq: r.seq, accountTail: String(r.accountDigits || '').slice(-4),
      amount: r.amount, holder: r.holder, status: r.statusRaw, success: r.success,
    })),
    orderAssigned: m.orderAssigned,
    summary: {
      ...m.summary,
      alreadyPaid: items.filter(it => it.status === 'paid').length,
      alreadyFailed: items.filter(it => it.status === 'failed').length,
    },
    fileBuffer: buf,
  };
}

/** 결과 원문 없이도 관리자 확인 화면을 다시 그릴 수 있는 최소·마스킹 보관본. */
function _previewArchive(a) {
  return {
    version: 1,
    bank: a.batch.bank,
    batchSeq: Number(a.batch.seq),
    batchStatus: a.batch.status,
    format: a.format,
    fileRows: a.parse.rows.length,
    warnings: a.parse.warnings || [],
    items: a.view.map(({ outcome, tabName, reviewerName, amount, accountTail, holder, transferredAt, resultStatus }) =>
      ({ outcome, tabName, reviewerName, amount, accountTail, holder, transferredAt, resultStatus })),
    unmatchedResults: a.unmatchedResults,
    orderAssigned: a.orderAssigned,
    summary: a.summary,
  };
}

/** 미리보기는 입금·실패 상태를 전혀 바꾸지 않는다. 마스킹된 화면 보관본만 감사 이력에 남긴다. */
async function previewResultFile({ batchId, fileName, base64, by }) {
  const a = await _analyze(batchId, fileName, base64);
  const preview = _previewArchive(a);
  const fileBlob = Buffer.from(a.fileBuffer);
  const fileSha256 = crypto.createHash('sha256').update(fileBlob).digest('hex');
  const { rows: [stored] } = await _db().query(
    `INSERT INTO payment_result_uploads
       (batch_id, bank, file_name, file_format, row_count, matched, success_count, failed_count, applied, summary, uploaded_by, file_blob, file_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9,$10,$11,$12)
     RETURNING id, uploaded_at`,
    [batchId, a.batch.bank, String(fileName || '').slice(0, 200), a.format,
      a.parse.rows.length, a.summary.matched, a.summary.success, a.summary.failed,
      JSON.stringify({ preview }), by || '', fileBlob, fileSha256]);
  return {
    ok: true,
    uploadId: stored && stored.id ? stored.id : null,
    canApply: (a.summary.success || 0) + (a.summary.failed || 0) > 0,
    fileName: String(fileName || ''),
    ...preview,
  };
}

/** 가장 최근의 저장된 결과 확인본. 원문 파일·전체 계좌번호는 절대 되돌려 주지 않는다. */
async function _hasAppliedFileSha256(fileSha256) {
  const { rows } = await _db().query(
    `SELECT id FROM payment_result_uploads
      WHERE file_sha256 = $1 AND applied = TRUE
      LIMIT 1`, [fileSha256]);
  return rows.length > 0;
}

async function _saveAutoApplyDecision(uploadId, autoApply) {
  if (!uploadId) return;
  await _db().query(
    `UPDATE payment_result_uploads
        SET summary = COALESCE(summary, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`,
    [uploadId, JSON.stringify({ autoApply })]);
}

/** Store every upload for audit, but change payment state only when the
 * explicitly approved auto-apply policy says the file belongs to this batch. */
async function autoApplyResultFile({ batchId, fileName, base64, by, notifyFailed }) {
  const a = await _analyze(batchId, fileName, base64);
  const fileSha256 = crypto.createHash('sha256').update(a.fileBuffer).digest('hex');
  const duplicateApplied = await _hasAppliedFileSha256(fileSha256);
  const autoApply = decideAutoApply({ summary: a.summary, duplicateApplied });
  const preview = await previewResultFile({ batchId, fileName, base64, by });
  await _saveAutoApplyDecision(preview.uploadId, autoApply);

  if (!autoApply.allowed) return { ...preview, canApply: false, autoApplied: false, autoApply };

  try {
    const applied = await applyResultFile({
      batchId, uploadId: preview.uploadId, by, notifyFailed, preventDuplicate: true,
    });
    return { ...preview, ...applied, canApply: false, autoApplied: true, autoApply };
  } catch (err) {
    // Another request can apply the same SHA after the first lookup.  Return
    // the safe duplicate warning instead of letting a second payment proceed.
    if (err instanceof ResultError && err.code === 'duplicate_file') {
      return {
        ...preview,
        canApply: false,
        autoApplied: false,
        autoApply: decideAutoApply({ summary: a.summary, duplicateApplied: true }),
      };
    }
    throw err;
  }
}

async function getLatestResultPreview(batchId) {
  if (!batchId) throw new ResultError('bad_request', '회차를 지정해 주세요.');
  const { rows: [row] } = await _db().query(
    `SELECT id, file_name, uploaded_at, applied, file_blob IS NOT NULL AS has_file, summary
       FROM payment_result_uploads
      WHERE batch_id = $1
      ORDER BY uploaded_at DESC, id DESC LIMIT 1`, [batchId]);
  const preview = row && row.summary && row.summary.preview;
  if (!preview || !Array.isArray(preview.items)) return { ok: true, found: false };
  return {
    ok: true, found: true, persisted: true, uploadId: row.id,
    canApply: row.applied !== true && row.has_file === true
      && ((preview.summary && preview.summary.success) || 0) + ((preview.summary && preview.summary.failed) || 0) > 0,
    applied: row.applied === true,
    fileName: row.file_name || '', uploadedAt: row.uploaded_at || null,
    autoApply: row.summary && row.summary.autoApply ? row.summary.autoApply : undefined,
    ...preview,
  };
}

/* ★★ 실패 안내 문구는 **여기 한 곳**(사용자 확정 ⑤ "등록한 계좌 정보를 확인해 주세요").
     ★ 은행 응답 원문(`result_status`)을 리뷰어에게 그대로 보내지 않는다 — 내부 표기이고,
       "예금주불일치" 같은 문구가 그대로 나가면 리뷰어가 무엇을 고쳐야 하는지 오히려 헷갈린다. */
const FAIL_NOTICE =
  '리뷰비 이체가 처리되지 않았습니다.\n' +
  '등록하신 계좌 정보(은행 · 계좌번호 · 예금주)를 다시 확인해 주세요.\n' +
  '내정보에서 계좌를 수정하시면 다음 이체 때 자동으로 다시 시도됩니다.';

/** 실패 건에 1:1문의 안내 전송 + `notified_at` 기록. ★ 절대 throw 하지 않는다(반영은 이미 커밋됐다). */
async function _notifyFailures(items, by) {
  const csBridge = require('./csBridge.service');
  let n = 0;
  for (const it of items) {
    if (!it.phone8) continue;   // 연락처를 모르면 보낼 곳이 없다(조용히 건너뛰고 건수로 드러난다)
    try {
      const out = await csBridge.postAdminNotice({
        sheetId: it.sheetId, tabName: it.tabName, rowIndex: it.rowIndex,
        reviewerName: it.reviewerName, phone8: it.phone8,
        message: FAIL_NOTICE, by: by || '관리자',
      });
      if (!out) continue;
      await _db().query(`UPDATE payment_batch_items SET notified_at = NOW() WHERE id = $1`, [it.id]);
      n++;
    } catch (e) {
      logger.warn(`[paymentResult] 실패 안내 전송 실패(${it.tabName}/${it.rowIndex}): ${e.message}`);
    }
  }
  return n;
}

/**
 * 반영 — 성공 건만 입금 기록. **서버가 파일을 다시 해석한다.**
 * @param {boolean} [notifyFailed] false 면 실패 안내(1:1문의)를 보내지 않는다(기본 = 보냄).
 */
async function applyResultFile({ batchId, fileName, base64, uploadId, by, notifyFailed, preventDuplicate = false }) {
  if (uploadId) {
    const { rows: [stored] } = await _db().query(
      `SELECT id, file_name, file_blob, file_sha256, applied
         FROM payment_result_uploads
        WHERE id = $1 AND batch_id = $2`, [uploadId, batchId]);
    if (!stored || !stored.file_blob) throw new ResultError('not_stored', '저장된 결과 파일을 찾을 수 없습니다. 결과 파일을 다시 업로드해 주세요.');
    if (stored.applied) throw new ResultError('already_applied', '이미 이체결과가 반영된 파일입니다.');
    if (stored.file_sha256 && crypto.createHash('sha256').update(stored.file_blob).digest('hex') !== stored.file_sha256) {
      throw new ResultError('file_changed', '저장된 결과 파일의 무결성을 확인하지 못했습니다. 결과 파일을 다시 업로드해 주세요.');
    }
    fileName = stored.file_name || fileName;
    base64 = Buffer.from(stored.file_blob).toString('base64');
  }
  const a = await _analyze(batchId, fileName, base64);
  const fileSha256 = crypto.createHash('sha256').update(a.fileBuffer).digest('hex');

  const success = a.pairs.filter(p => p.success);
  const failed  = a.pairs.filter(p => p.result && !p.success);
  if (!success.length && !failed.length) {
    throw new ResultError('empty', '이 회차에 반영할 결과가 없습니다(결과 파일과 짝지어진 건이 0건입니다).');
  }

  const paidItems = [];     // 배경 입금칸 기록 대상(성공 건)
  const failedItems = [];   // 실패 안내(1:1문의) 대상 — 아직 안내를 보내지 않은 건만
  const client = await _db().connect();
  try {
    await client.query('BEGIN');

    if (preventDuplicate) {
      // Serialize same-file uploads before changing any payment item.  A hash
      // collision can only wait; it can never create a second payment.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fileSha256]);
      const { rows: priorApplied } = await client.query(
        `SELECT id FROM payment_result_uploads
          WHERE file_sha256 = $1 AND applied = TRUE AND id <> $2
          LIMIT 1`, [fileSha256, uploadId || '']);
      if (priorApplied.length) {
        throw new ResultError('duplicate_file', '이미 반영된 동일 이체결과 파일입니다. 중복 이체 여부를 확인해 주세요.');
      }
    }

    // 회차 행 잠금 — 동시에 두 사람이 같은 회차에 파일을 올리는 경합 차단
    const { rows: [b] } = await client.query(
      `SELECT * FROM payment_batches WHERE id = $1 FOR UPDATE`, [batchId]);
    if (!b) throw new ResultError('not_found', '회차를 찾을 수 없습니다.');
    if (b.status === 'cancelled') throw new ResultError('cancelled', '취소된 회차입니다.');

    for (const p of success) {
      const it = p.item;
      const paidAtIso = p.result.transferredAtIso || null;
      /* ★ 조건부 UPDATE — `status='pending'` 인 건만 바꾼다.
           잠금을 잡기 전에 다른 요청이 먼저 처리했다면 rowCount 0 으로 조용히 건너뛴다(이중입금 0). */
      const r = await client.query(
        `UPDATE payment_batch_items
            SET status = 'paid', paid_at = COALESCE($2::timestamptz, NOW()),
                result_status = $3, result_seq = $4, fail_reason = NULL
          WHERE id = $1 AND status = 'pending'`,
        [it.id, paidAtIso, p.result.statusRaw || '', p.result.seq]);
      if (!r.rowCount) continue;
      paidItems.push({
        sheetId: it.sheetId, tabName: it.tabName, rowIndex: it.rowIndex,
        reviewerName: it.reviewerName, amount: String(it.amount || ''),
        depositColKey: null, gid: '',
        stamp: _depositDateFromResultStamp(p.result.transferredStamp),
        paidAt: paidAtIso,
      });
    }

    for (const p of failed) {
      const it = p.item;
      const r = await client.query(
        `UPDATE payment_batch_items
            SET status = 'failed', result_status = $2, result_seq = $3, fail_reason = $4
          WHERE id = $1 AND status = 'pending'
        RETURNING notified_at`,
        [it.id, p.result.statusRaw || '', p.result.seq,
         `이체 실패 — 은행 처리상태: ${p.result.statusRaw || '(빈 값)'}`]);
      // ★ 이미 안내를 보낸 건은 다시 보내지 않는다(재반영 시 도배 방지)
      if (r.rowCount && !r.rows[0].notified_at) failedItems.push(it);
    }

    /* ★ 입금 기록(review_index PAID + payment_records)은 같은 트랜잭션 안에서 —
         회차 항목만 paid 로 바뀌고 원장이 안 남는 어긋난 상태를 만들지 않는다. */
    const updated = paidItems.length
      ? await recordDeposits(client, paidItems, { by: by || '' })
      : 0;

    // 입금칸 열쇠(submit_col2)·gid 를 그 행의 검색 인덱스에서 채운다(시트 경로에 필요)
    if (paidItems.length) {
      const { rows: metaRows } = await client.query(
        `SELECT sheet_id, tab_name, row_index, submit_col2, tab_gid
           FROM review_index
          WHERE (sheet_id, tab_name, row_index) IN (${
            paidItems.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',')})`,
        paidItems.flatMap(x => [x.sheetId, x.tabName, x.rowIndex]));
      const metaMap = new Map(metaRows.map(r => [`${r.sheet_id}\u0000${r.tab_name}\u0000${r.row_index}`, r]));
      for (const x of paidItems) {
        const meta = metaMap.get(`${x.sheetId}\u0000${x.tabName}\u0000${x.rowIndex}`);
        if (meta) { x.depositColKey = meta.submit_col2 || null; x.gid = meta.tab_gid || ''; }
      }
    }

    // 사람이 [이대로 반영]을 확정한 회차는 결과없음 건이 남아도 '반영 완료'로 표시한다.
    // pending 건은 그대로 남아 이후 결과 파일로 추가 반영할 수 있다.
    const { rows: [{ n: remaining }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE batch_id = $1 AND status = 'pending'`,
      [batchId]);
    await client.query(
      `UPDATE payment_batches SET status = 'applied', applied_at = NOW(), applied_by = $2 WHERE id = $1`,
      [batchId, by || '']);

    const applySummary = JSON.stringify({ apply: {
      warnings: a.parse.warnings || [], orderAssigned: a.orderAssigned,
      unmatchedResults: a.unmatchedResults.length, notInFile: a.summary.notInFile,
      remainingPending: remaining,
    } });
    if (uploadId) {
      await client.query(
        `UPDATE payment_result_uploads
            SET matched = $3, success_count = $4, failed_count = $5,
                applied = TRUE, applied_count = $6, applied_at = NOW(),
                summary = COALESCE(summary, '{}'::jsonb) || $7::jsonb
          WHERE id = $1 AND batch_id = $2`,
        [uploadId, batchId, a.summary.matched, paidItems.length, failed.length, paidItems.length, applySummary]);
    } else {
      await client.query(
        `INSERT INTO payment_result_uploads
           (batch_id, bank, file_name, file_format, row_count, matched, success_count, failed_count, applied, applied_count, applied_at, summary, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,NOW(),$10,$11)`,
        [batchId, a.batch.bank, String(fileName || '').slice(0, 200), a.format,
         a.parse.rows.length, a.summary.matched, paidItems.length, failed.length,
         paidItems.length, applySummary, by || '']);
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  /* ★ 결과 반영은 반환 전에 작업보드 입금칸 쓰기 결과까지 확인한다.
       ★ 날짜는 결과파일의 건별 실제 이체일(item.stamp)만 사용한다. */
  const boardItems = paidItems.filter(x => x.stamp);
  const undatedPaid = paidItems.length - boardItems.length;
  const writeResult = await paymentApply.markDepositCells(boardItems, { by: by || 'payment' }) || {};
  const verification = await paymentApply.verifyDepositCells(boardItems) || {};
  const verified = Number(verification.verified) || 0;
  const queued = Number(writeResult.queued) || 0;
  const verificationMissing = Math.max(0, (Number(verification.missing) || 0) - queued);
  const board = {
    recorded: verified,
    queued,
    skipped: (Number(writeResult.skipped) || 0) + undatedPaid,
    failed: (Number(writeResult.failed) || 0) + verificationMissing,
  };
  const boardStamp = [...new Set(boardItems.map(x => x.stamp))].join(', ');
  await _saveBoardWriteOutcome({ batchId, outcome: board, stamp: boardStamp, by: by || 'payment' });

  // 실패 안내(1:1문의) — 기본 켬(사용자 확정 ⑤). 커밋 뒤에 보낸다(전송 실패가 반영을 되돌리지 않게).
  let notified = 0;
  if (notifyFailed !== false && failedItems.length) {
    notified = await _notifyFailures(failedItems, by).catch(e => {
      logger.warn(`[paymentResult] 실패 안내 전송 예외: ${e.message}`);
      return 0;
    });
  }

  return {
    ok: true,
    uploadId: uploadId || null,
    notified,
    notifyTargets: failedItems.length,
    applied: paidItems.length,
    board,
    failed: failed.length,
    notInFile: a.summary.notInFile,
    unmatchedResults: a.unmatchedResults.length,
    orderAssigned: a.orderAssigned,
    warnings: a.parse.warnings || [],
    summary: a.summary,
  };
}

/**
 * 과거 반영분의 회차 상태만 정합화한다. 입금 기록이나 항목 상태는 절대 다시 쓰지 않는다.
 */
async function markBatchApplied({ batchId, by }) {
  const client = await _db().connect();
  try {
    await client.query('BEGIN');
    const { rows: [batch] } = await client.query(
      'SELECT * FROM payment_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!batch) throw new ResultError('not_found', '회차를 찾을 수 없습니다.');
    if (batch.status === 'cancelled') throw new ResultError('cancelled', '취소된 회차는 적용완료로 처리할 수 없습니다.');

    const { rows: [{ n: appliedItems }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_batch_items
        WHERE batch_id = $1 AND status IN ('paid', 'failed')`, [batchId]);
    if (appliedItems === 0) {
      throw new ResultError('no_applied_items', '이미 반영된 이체 결과가 없어 상태를 완료로 바꿀 수 없습니다.');
    }
    const { rows: [{ n: remainingPending }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE batch_id = $1 AND status = 'pending'`,
      [batchId]);
    await client.query(
      `UPDATE payment_batches SET status = 'applied', applied_at = NOW(), applied_by = $2 WHERE id = $1`,
      [batchId, by || '']);
    await client.query('COMMIT');
    return { ok: true, appliedItems, remainingPending };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 이미 paid 로 확정된 회차 항목의 작업표 입금 칸만 다시 기록한다.
 * DB 입금 원장(payment_records)이나 항목 상태는 변경하지 않는다.
 */
async function backfillPaidDepositStamp({ batchId, by }) {

  const client = await _db().connect();
  let items = [];
  try {
    await client.query('BEGIN');
    const { rows: [batch] } = await client.query(
      'SELECT * FROM payment_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!batch) throw new ResultError('not_found', '회차를 찾을 수 없습니다.');
    if (batch.status === 'cancelled') throw new ResultError('cancelled', '취소된 회차에는 입금일을 기록할 수 없습니다.');
    const { rows } = await client.query(
      `SELECT i.sheet_id, i.tab_name, i.row_index, i.paid_at,
              COALESCE(p.sheet_id, i.sheet_id) AS target_sheet_id,
              COALESCE(p.tab_name, i.tab_name) AS target_tab_name,
              COALESCE(p.submit_col2, target_r.submit_col2, r.submit_col2) AS submit_col2,
              COALESCE(p.tab_gid, target_r.tab_gid, r.tab_gid, rc.linked_tab_gid) AS tab_gid,
              COALESCE(p.seq, i.row_index) AS target_row_index,
              COALESCE(target_tc.sheetless, FALSE) AS sheetless
         FROM payment_batch_items i
         LEFT JOIN review_index r
           ON r.sheet_id = i.sheet_id AND r.tab_name = i.tab_name AND r.row_index = i.row_index
         -- A payment row keeps the tab identity at download time.  The board can
         -- be rebuilt or renamed before the result arrives, so prefer the live
         -- campaign link (gid first) when resolving the row to write back.
         LEFT JOIN recruit_campaigns rc ON rc.id = i.campaign_id
         LEFT JOIN LATERAL (
           SELECT cp.sheet_id, cp.tab_name, cp.seq, cp.submit_col2, cp.tab_gid
             FROM campaign_participants cp
            WHERE cp.deleted_at IS NULL AND cp.active = TRUE
              AND (
                (
                  cp.sheet_id = COALESCE(NULLIF(rc.linked_sheet_id, ''), i.sheet_id)
                  AND (
                    (NULLIF(rc.linked_tab_gid, '') IS NOT NULL AND cp.tab_gid = rc.linked_tab_gid)
                    OR (NULLIF(rc.linked_tab_gid, '') IS NULL
                        AND cp.tab_name = COALESCE(NULLIF(rc.linked_tab_name, ''), i.tab_name))
                  )
                )
                OR (cp.sheet_id = i.sheet_id AND cp.tab_name = i.tab_name)
              )
              AND (
                cp.seq = i.row_index
                OR (
                  COALESCE(i.phone8, '') <> '' AND cp.phone8 = i.phone8
                  AND 1 = (
                    SELECT COUNT(*)
                      FROM campaign_participants same_phone
                     WHERE same_phone.sheet_id = cp.sheet_id AND same_phone.tab_name = cp.tab_name
                       AND same_phone.phone8 = i.phone8 AND same_phone.deleted_at IS NULL
                       AND same_phone.active = TRUE
                  )
                )
              )
            ORDER BY
              (cp.sheet_id = COALESCE(NULLIF(rc.linked_sheet_id, ''), i.sheet_id)
                AND ((NULLIF(rc.linked_tab_gid, '') IS NOT NULL AND cp.tab_gid = rc.linked_tab_gid)
                  OR (NULLIF(rc.linked_tab_gid, '') IS NULL
                    AND cp.tab_name = COALESCE(NULLIF(rc.linked_tab_name, ''), i.tab_name)))) DESC,
              (cp.seq = i.row_index) DESC
            LIMIT 1
         ) p ON TRUE
         LEFT JOIN review_index target_r
           ON target_r.sheet_id = COALESCE(p.sheet_id, i.sheet_id)
          AND target_r.tab_name = COALESCE(p.tab_name, i.tab_name)
          AND target_r.row_index = COALESCE(p.seq, i.row_index)
         LEFT JOIN tab_configs target_tc
           ON target_tc.sheet_id = COALESCE(p.sheet_id, i.sheet_id)
          AND target_tc.tab_name = COALESCE(p.tab_name, i.tab_name)
        WHERE i.batch_id = $1 AND i.status = 'paid'
        ORDER BY i.created_at, i.id`, [batchId]);
    items = rows.map(r => ({
      sheetId: r.target_sheet_id, tabName: r.target_tab_name, rowIndex: r.target_row_index,
      depositColKey: r.submit_col2 || null, gid: r.tab_gid || '', sheetless: r.sheetless === true,
      stamp: _depositDateFromPaidAt(r.paid_at),
    })).filter(x => x.sheetId && x.tabName && x.rowIndex);
    if (!items.length) throw new ResultError('no_paid_items', '입금일을 기록할 완료 항목이 없습니다.');
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  const datedItems = items.filter(x => x.stamp);
  const normalizedStamp = [...new Set(datedItems.map(x => x.stamp))].join(', ');
  const writeResult = await paymentApply.markDepositCells(datedItems,
    { by: by || 'payment', deferSheetlessRebuild: true }) || {};
  const sheetlessTabs = [...new Map(datedItems.filter(x => x.sheetless)
    .map(x => [`${x.sheetId}\t${x.tabName}`, x])).values()];
  for (const tab of sheetlessTabs) {
    await rebuildLedgers({ sheetId: tab.sheetId, tabName: tab.tabName, by: by || 'payment' });
  }
  const verification = await paymentApply.verifyDepositCells(datedItems) || {};
  const queued = Number(writeResult.queued) || 0;
  const verificationMissing = Math.max(0, (Number(verification.missing) || 0) - queued);
  const outcome = {
    recorded: Number(verification.verified) || 0,
    queued,
    skipped: (Number(writeResult.skipped) || 0) + (items.length - datedItems.length),
    failed: (Number(writeResult.failed) || 0) + verificationMissing,
  };
  await _saveBoardWriteOutcome({ batchId, outcome, stamp: normalizedStamp, by: by || 'payment' });
  return { ok: true, candidates: items.length, stamp: normalizedStamp, verified: outcome.recorded, ...outcome };
}

/** 확인된 은행 실패만 pending 에서 failed 로 확정한다. 실패 안내는 별도 발송하지 않는다. */
async function confirmOutstandingFailures({ batchId, by }) {
  const client = await _db().connect();
  try {
    await client.query('BEGIN');
    const { rows: [batch] } = await client.query(
      'SELECT * FROM payment_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!batch) throw new ResultError('not_found', '회차를 찾을 수 없습니다.');
    if (batch.status === 'cancelled') throw new ResultError('cancelled', '취소된 회차는 실패 처리할 수 없습니다.');
    const { rows: pending } = await client.query(
      `SELECT id FROM payment_batch_items
        WHERE batch_id = $1 AND status = 'pending' FOR UPDATE`, [batchId]);
    if (!pending.length) throw new ResultError('no_pending_items', '실패 처리할 대기 항목이 없습니다.');
    for (const item of pending) {
      await client.query(
        `UPDATE payment_batch_items
            SET status = 'failed', result_status = $2, fail_reason = $3
          WHERE id = $1 AND status = 'pending'`,
        [item.id, '관리자 확인: 이체 실패', '관리자 확인 이체 실패']);
    }
    await client.query('COMMIT');
    return { ok: true, failed: pending.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { previewResultFile, autoApplyResultFile, getLatestResultPreview, applyResultFile, markBatchApplied, backfillPaidDepositStamp, confirmOutstandingFailures, decideAutoApply, ResultError, MAX_BASE64, AUTO_APPLY_MATCH_RATE, FAIL_NOTICE, __setPoolForTest };
