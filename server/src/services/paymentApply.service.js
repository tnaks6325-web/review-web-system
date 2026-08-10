'use strict';
/**
 * 입금 기록 단일 출처 (M1 수동 처리 · M2 이체결과 반영 공용)
 *
 * ★★ 왜 서비스로 뺐나: "입금됐다"를 기록하는 일은 네 군데를 동시에 건드린다 —
 *    ① `review_index.is_submitted2='PAID'` ② `payment_records` 이력
 *    ③ **무시트 탭**이면 작업표 입금 칸(W3-a `sheetlessStatus.markStatusCell`)
 *    ④ 시트 탭이면 구글시트 입금 칸(실패 시 `deposit_mark` 큐).
 *    이 순서를 사본으로 두면 "관리자 수동 처리는 작업표에 남는데 M2 자동 반영은 안 남는다" 같은
 *    드리프트가 조용히 생긴다(무시트 탭에서는 다음 장부 재생성에 ①이 지워지므로 ③이 유일한 생존 경로다).
 *
 * ★ **시점(stamp)은 호출자가 준다** — 수동 처리는 '지금', M2 는 **결과 파일의 실제 이체시점**
 *   (사용자 확정 ④ "입금칸 기록값 = 결과 파일의 실제 이체시점"). 그래서 건별 stamp 를 허용한다.
 *
 * ★ 시트 쓰기는 **응답 뒤 백그라운드**로 도는 기존 계약을 그대로 유지한다(호출부가 setImmediate).
 */

const { writeSheet, readSheet } = require('./sheets.service');
const { enqueue } = require('./syncQueue.service');
const { logger } = require('../utils/logger');

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
 * 이체완료시각 표기 "YYYY.M.D HH:mm" (Asia/Seoul)
 * ★ 시트/작업표 입금 칸에 그대로 찍히는 문자열이라 형식을 바꾸면 과거 표기와 갈린다.
 * @param {Date} [when] 없으면 지금
 */
function nowStamp(when) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when || new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;   // 자정 표기 '24' 방어
  return `${p.year}.${p.month}.${p.day} ${hh}:${p.minute}`;
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
  let updated = 0;
  for (const item of (items || [])) {
    const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
    const r = await client.query(
      `UPDATE review_index SET is_submitted2 = 'PAID'
       WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
      [item.sheetId, item.tabName, rowIndex]
    );
    updated += r.rowCount;

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
 * ③④ 입금 칸 기록 — 무시트면 작업표, 시트면 구글시트(실패 시 큐).
 *  ★ 절대 throw 하지 않는다(백그라운드 후처리라 예외가 오르면 아무도 안 잡는다).
 *
 * @param {Array}  items [{sheetId, tabName, rowIndex|rowNum, gid, depositColKey, stamp?}]
 * @param {object} opts  {by, stamp}  stamp = 기본 표기값. 건별 item.stamp 가 우선.
 */
async function markDepositCells(items, opts = {}) {
  const by = opts.by || 'payment';
  const headerCache = {};
  for (const item of (items || [])) {
    const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
    const stamp = item.stamp || opts.stamp;
    const depositColKey = item.depositColKey;

    /* ★★ 무시트 탭 — `review_index.is_submitted2='PAID'` 는 **다음 장부 재생성에 지워진다**
       (재생성이 review_index 를 지우고 작업표에서 다시 만든다). 시트 쓰기도 막혀 있으므로
       작업표 입금 칸에 스탬프를 남겨야 **입금 표시가 살아남는다**(W3-a).
       ★ 입금 칸 헤더명은 파서가 감지한 `submit_col2` 를 쓰므로 depositColKey 가 없어도 동작한다
         (그 값은 화면이 준 힌트일 뿐 — 무시트에서는 서버가 다시 정한다). */
    try {
      const st = await require('./sheetlessStatus.service').markStatusCell({
        sheetId: item.sheetId, tabName: item.tabName, rowIndex,
        kind: 'paid', value: stamp, by,
      });
      if (st.handled) {
        if (st.ok) logger.info(`[paymentApply] 무시트 입금칸 기록 (tab=${item.tabName}, row=${rowIndex}, col=${st.column})`);
        else logger.warn(`[paymentApply] 무시트 입금칸 기록 실패 (tab=${item.tabName}, row=${rowIndex}) reason=${st.reason}`);
        continue;   // ★ 시트 쓰기·deposit_mark 큐로 내려가지 않는다(무시트에는 쓸 시트가 없다)
      }
    } catch (e) {
      logger.warn(`[paymentApply] 무시트 판정 예외 → 시트 경로로 진행: ${e.message}`);
    }

    if (!depositColKey || !rowIndex) continue; // 입금컬럼 미지정 행은 시트 기록 생략
    try {
      const cacheKey = item.sheetId + '||' + item.tabName;
      let headers = headerCache[cacheKey];
      if (!headers) {
        const hv = await readSheet(item.sheetId, `'${item.tabName}'!1:50`);
        headers = detectHeaderRow(hv);
        headerCache[cacheKey] = headers;
      }
      const colIdx = headers.findIndex(h => h === depositColKey);
      if (colIdx < 0) throw new Error(`입금컬럼 '${depositColKey}' 을 헤더에서 찾을 수 없음`);
      const range = `'${item.tabName}'!${colLetter(colIdx)}${rowIndex}`;
      await writeSheet(item.sheetId, range, [[stamp]], item.gid ? { gid: item.gid } : {});
      logger.info(`[paymentApply] 입금칸 기록 성공 (tab=${item.tabName}, row=${rowIndex})`);
    } catch (bgErr) {
      logger.warn(`[paymentApply] 시트 쓰기 실패 → 큐 등록: ${bgErr.message}`);
      try {
        await enqueue('deposit_mark', {
          sheetId: item.sheetId,
          tabName: item.tabName,
          rowIndex,
          depositColKey,
          value: stamp,
          gid: item.gid || '',
        });
      } catch (qErr) {
        logger.error(`[paymentApply] 큐 등록도 실패: ${qErr.message}`);
      }
    }
  }
}

module.exports = { nowStamp, colLetter, detectHeaderRow, recordDeposits, markDepositCells };
