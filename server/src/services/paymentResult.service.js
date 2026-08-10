'use strict';
/**
 * 리뷰비 입금 M2 — 이체결과 파일 반영
 *
 *  흐름 = ① 결과 파일 업로드 → ② 해석(`utils/paymentResultParse`) → ③ 회차 건과 짝 맞추기
 *        → ④ **사람이 확인 화면에서 [이대로 반영]** → ⑤ 성공 건만 입금 기록.
 *
 * ★★ 미리보기(preview)는 **쓰기 0**. 반영(apply)만 기록한다(회차 취소·시트 우위 점검과 같은 규율).
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

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { loadSheetAoa } = require('../utils/spreadsheetLoad');
const { parseResultAoa, matchResults, digitsOnly } = require('../utils/paymentResultParse');
const { nowStamp, recordDeposits, markDepositCells } = require('./paymentApply.service');

const MAX_BASE64 = 16 * 1024 * 1024;   // base64 는 원본의 약 1.34배 — 12MB 파일까지 수용

class ResultError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
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

  const { rows: [b] } = await pool.query(`SELECT * FROM payment_batches WHERE id = $1`, [batchId]);
  if (!b) throw new ResultError('not_found', '회차를 찾을 수 없습니다.');
  if (b.status === 'cancelled') throw new ResultError('cancelled', '취소된 회차입니다.');

  let buf;
  try { buf = Buffer.from(String(base64), 'base64'); }
  catch (_) { throw new ResultError('bad_file', '파일을 읽지 못했습니다.'); }

  const loaded = loadSheetAoa(buf, fileName || '');
  if (!loaded.ok) throw new ResultError('bad_file', loaded.error);

  const parse = parseResultAoa(loaded.aoa, { expectBank: b.bank });
  if (!parse.ok) throw new ResultError('parse_failed', parse.error);

  const { rows: itemRows } = await pool.query(
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
  };
}

/** 미리보기 — 쓰기 0 */
async function previewResultFile({ batchId, fileName, base64 }) {
  const a = await _analyze(batchId, fileName, base64);
  return {
    ok: true,
    bank: a.batch.bank,
    batchSeq: Number(a.batch.seq),
    batchStatus: a.batch.status,
    format: a.format,
    fileRows: a.parse.rows.length,
    warnings: a.parse.warnings || [],
    items: a.view,
    unmatchedResults: a.unmatchedResults,
    orderAssigned: a.orderAssigned,
    summary: a.summary,
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
      await pool.query(`UPDATE payment_batch_items SET notified_at = NOW() WHERE id = $1`, [it.id]);
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
async function applyResultFile({ batchId, fileName, base64, by, notifyFailed }) {
  const a = await _analyze(batchId, fileName, base64);
  const stampNow = nowStamp();

  const success = a.pairs.filter(p => p.success);
  const failed  = a.pairs.filter(p => p.result && !p.success);
  if (!success.length && !failed.length) {
    throw new ResultError('empty', '이 회차에 반영할 결과가 없습니다(결과 파일과 짝지어진 건이 0건입니다).');
  }

  const paidItems = [];     // 배경 입금칸 기록 대상(성공 건)
  const failedItems = [];   // 실패 안내(1:1문의) 대상 — 아직 안내를 보내지 않은 건만
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
        stamp: p.result.transferredStamp || stampNow,
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

    // 회차 상태 — 남은 pending 이 없을 때만 '반영 완료'로 닫는다(결과 없음 건이 남으면 추가 파일을 더 받을 수 있게)
    const { rows: [{ n: remaining }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE batch_id = $1 AND status = 'pending'`,
      [batchId]);
    if (remaining === 0) {
      await client.query(
        `UPDATE payment_batches SET status = 'applied', applied_at = NOW(), applied_by = $2 WHERE id = $1`,
        [batchId, by || '']);
    } else {
      await client.query(
        `UPDATE payment_batches SET applied_at = NOW(), applied_by = $2 WHERE id = $1`,
        [batchId, by || '']);
    }

    await client.query(
      `INSERT INTO payment_result_uploads
         (batch_id, bank, file_name, file_format, row_count, matched, success_count, failed_count, applied, summary, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)`,
      [batchId, a.batch.bank, String(fileName || '').slice(0, 200), a.format,
       a.parse.rows.length, a.summary.matched, paidItems.length, failed.length,
       JSON.stringify({
         warnings: a.parse.warnings || [],
         orderAssigned: a.orderAssigned,
         unmatchedResults: a.unmatchedResults.length,
         notInFile: a.summary.notInFile,
         remainingPending: remaining,
       }), by || '']);

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  /* ★ 입금칸 기록은 커밋 뒤 백그라운드(수동 처리와 같은 계약) — 시트/Drive 지연이 응답을 붙잡지 않는다.
       ★ 시각은 **건별 실제 이체시점**(item.stamp). */
  setImmediate(() => markDepositCells(paidItems, { stamp: stampNow, by: by || 'payment' })
    .catch(e => logger.warn(`[paymentResult] 입금칸 기록 예외: ${e.message}`)));

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
    notified,
    notifyTargets: failedItems.length,
    applied: paidItems.length,
    failed: failed.length,
    notInFile: a.summary.notInFile,
    unmatchedResults: a.unmatchedResults.length,
    orderAssigned: a.orderAssigned,
    warnings: a.parse.warnings || [],
    summary: a.summary,
  };
}

module.exports = { previewResultFile, applyResultFile, ResultError, MAX_BASE64, FAIL_NOTICE };
