'use strict';
/**
 * 입금 기록 단일 출처 (M1 수동 처리 · M2 이체결과 반영 공용)
 *
 * ★★ 왜 서비스로 뺐나: "입금됐다"를 기록하는 일은 서버 DB 원장과 작업표를 함께 맞춘다 —
 *    ① `review_index.is_submitted2='PAID'` ② `payment_records` 이력
 *    ③ **무시트 탭**이면 작업표 입금 칸(W3-a `sheetlessStatus.markStatusCell`)
 *    이 순서를 사본으로 두면 "관리자 수동 처리는 작업표에 남는데 M2 자동 반영은 안 남는다" 같은
 *    드리프트가 조용히 생긴다(무시트 탭에서는 다음 장부 재생성에 ①이 지워지므로 ③이 유일한 생존 경로다).
 *
 * ★ **시점(stamp)은 호출자가 준다** — 수동 처리는 '지금', M2 는 **결과 파일의 실제 이체시점**
 *   (사용자 확정 ④ "입금칸 기록값 = 결과 파일의 실제 이체시점"). 그래서 건별 stamp 를 허용한다.
 *
 * ★ 입금 처리에서 구글시트와 `deposit_mark` 큐는 사용하지 않는다.
 */

const { logger } = require('../utils/logger');
const { formatDepositStamp, mergeDepositStamps } = require('../utils/depositStamp');

/** 열 인덱스 → 알파벳 (A=0) */
function colLetter(colIdx) {
  let letter = '';
  let idx = colIdx;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

/** 헤더 행 탐색 (키워드 2개 이상 포함된 행) */
function detectHeaderRow(headerValues) {
  if (!headerValues || !headerValues.length) return [];
  const KW = ['주문자', '수취인', '연락처', '주소', '은행', '계좌', '금액', '아이디', '인애드', '리뷰', '입금'];
  let headerRow = headerValues[0];
  for (const row of headerValues) {
    const m = (row || []).filter(c => KW.some(k => String(c || '').includes(k))).length;
    if (m >= 2) { headerRow = row; break; }
  }
  return headerRow.map(h => String(h || '').trim());
}

/**
 * 이체완료시각 표기 "M/D HH:mm" (Asia/Seoul)
 * ★ 시트/작업표 입금 칸과 리뷰제출일 표기를 통일한다.
 * @param {Date} [when] 없으면 지금
 */
function nowStamp(when) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when || new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;   // 자정 표기 '24' 방어
  return formatDepositStamp(`${p.month}/${p.day} ${hh}:${p.minute}`);
}

/**
 * ①② DB 기록 — 호출자가 트랜잭션(client)을 소유한다.
 *  M2 는 같은 tx 안에서 `payment_batch_items` 도 함께 갱신하므로 client 를 받는 형태여야 한다.
 *
 * @param {object} client  pg client (BEGIN 은 호출자가)
 * @param {Array}  items   [{sheetId, tabName, rowIndex|rowNum, reviewerName, amount, paidAt?}]
 * @param {object} opts    {by, paidAt?}  paidAt = 기본 입금시각(ISO/Date). 건별 item.paidAt 이 우선.
 * @returns {Promise<number>} review_index 가 실제로 갱신된 행 수
 */
async function recordDeposits(client, items, opts = {}) {
  const by = opts.by || '';
  const appliedItems = Array.isArray(opts.appliedItems) ? opts.appliedItems : null;
  let updated = 0;
  for (const item of (items || [])) {
    const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
    const r = await client.query(
      `UPDATE review_index SET is_submitted2 = 'PAID'
       WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3
         AND is_submitted2 IS DISTINCT FROM 'PAID'`,
      [item.sheetId, item.tabName, rowIndex]
    );
    updated += r.rowCount;
    if (!r.rowCount) continue;
    if (appliedItems) appliedItems.push(item);

    // ★ paid_at 은 값이 있을 때만 넣는다(없으면 DEFAULT NOW() = 종전 동작 그대로).
    const paidAt = item.paidAt || opts.paidAt || null;
    await client.query(
      `INSERT INTO payment_records (sheet_id, tab_name, reviewer_name, row_index, amount, paid_by, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))`,
      [item.sheetId, item.tabName, item.reviewerName || '', rowIndex,
       item.amount || '', by, paidAt]
    );
  }
  return updated;
}

/**
 * ③ DB 작업표 입금 칸 기록 — 무시트 탭만 보조 입금일을 남긴다.
 *  ★ 절대 throw 하지 않는다(입금 원장 기록 뒤의 보조 작업이므로 예외가 원장을 되돌리면 안 된다).
 *
 * @param {Array}  items [{sheetId, tabName, rowIndex|rowNum, gid, depositColKey, stamp?}]
 * @param {object} opts  {by, stamp}  stamp = 기본 표기값. 건별 item.stamp 가 우선.
 */
async function markDepositCells(items, opts = {}) {
  const by = opts.by || 'payment';
  const outcome = { total: Array.isArray(items) ? items.length : 0, recorded: 0, queued: 0, skipped: 0, failed: 0 };
  for (const item of (items || [])) {
    const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
    const stamp = item.stamp || opts.stamp;
    if (!item.sheetId || !item.tabName || !rowIndex || !stamp) { outcome.skipped += 1; continue; }

    // 입금 원장은 DB(review_index + payment_records)만 사용한다. 무시트 작업표의
    // 날짜 칸 역시 DB에만 보조 기록하며, 시트 기반 탭은 추가 외부 쓰기를 하지 않는다.
    try {
      const st = await require('./sheetlessStatus.service').markStatusCell({
        sheetId: item.sheetId, tabName: item.tabName, rowIndex,
        kind: 'paid', value: stamp, by, deferRebuild: opts.deferSheetlessRebuild === true,
      });
      if (st.handled) {
        if (st.ok) outcome.recorded += 1;
        else outcome.failed += 1;
        if (st.ok) logger.info(`[paymentApply] 무시트 입금칸 기록 (tab=${item.tabName}, row=${rowIndex}, col=${st.column})`);
        else logger.warn(`[paymentApply] 무시트 입금칸 기록 실패 (tab=${item.tabName}, row=${rowIndex}) reason=${st.reason}`);
        continue;
      }
    } catch (e) {
      logger.warn(`[paymentApply] DB 작업표 입금칸 기록 실패 (tab=${item.tabName}, row=${rowIndex}): ${e.message}`);
      outcome.failed += 1;
      continue;
    }
    outcome.skipped += 1;
  }
  outcome.skipped = Math.max(0, outcome.total - outcome.recorded - outcome.queued - outcome.failed);
  return outcome;
}

/**
 * Read-after-write verification for the rendered workboard value.  `recorded`
 * must never mean merely that an UPDATE was issued; the requested transfer
 * date has to survive ledger rebuilding and be visible in the workboard data.
 */
async function verifyDepositCells(items) {
  const outcome = { total: Array.isArray(items) ? items.length : 0, verified: 0, missing: 0 };
  for (const item of (items || [])) {
    const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
    const stamp = item.stamp;
    if (!item.sheetId || !item.tabName || !rowIndex || !stamp) { outcome.missing += 1; continue; }
    try {
      const st = await require('./sheetlessStatus.service').verifyStatusCell({
        sheetId: item.sheetId, tabName: item.tabName, rowIndex, kind: 'paid', value: stamp,
      });
      if (st.handled) {
        if (st.ok) outcome.verified += 1;
        else outcome.missing += 1;
        continue;
      }
      // 시트 기반 탭은 review_index/payment_records의 트랜잭션 기록이 작업보드의 유일한 입금 근거다.
      outcome.verified += 1;
    } catch (e) {
      logger.warn(`[paymentApply] 입금칸 재확인 실패 (tab=${item.tabName}, row=${rowIndex}): ${e.message}`);
      outcome.missing += 1;
    }
  }
  return outcome;
}

module.exports = { nowStamp, colLetter, detectHeaderRow, recordDeposits, markDepositCells, verifyDepositCells, mergeDepositStamps };
