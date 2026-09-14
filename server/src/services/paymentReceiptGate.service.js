'use strict';

/**
 * 현금영수증 대상 작업의 입금 게이트.
 *
 * 입금목록 API와 회차 생성은 반드시 이 함수를 거친다. 현금영수증 대상 여부는
 * captureSlots 공용 규칙으로 판정하고, 실제 제출 여부는 review_submissions의 현재 slot_key로
 * 확인한다. 조회 실패 시 대상을 추측해 지급하지 않도록 예외를 그대로 올린다.
 */
const { cashReceiptSlotInfo } = require('../utils/captureSlots');
const { cashReceiptRequirementsForTabs } = require('./cashReceiptContext.service');

const pairKey = (sheetId, tabName) => `${sheetId}\u0000${tabName}`;
const rowKey = (sheetId, tabName, rowIndex) => `${sheetId}\u0000${tabName}\u0000${rowIndex}`;

async function cashReceiptSubmissionStates(db, rows) {
  const source = Array.isArray(rows) ? rows : [];
  const states = new Map();
  if (!source.length) return states;

  const pairs = [];
  const seenPairs = new Set();
  for (const row of source) {
    const key = pairKey(row.sheetId, row.tabName);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairs.push({ sheetId: row.sheetId, tabName: row.tabName });
  }

  const { rows: configs } = await db.query(
    `WITH requested AS (
       SELECT * FROM UNNEST($1::text[], $2::text[]) AS r(sheet_id, tab_name)
     )
     SELECT r.sheet_id AS "sheetId", r.tab_name AS "tabName",
            tc.capture_slots AS "captureSlots", tc.income_type AS "incomeType"
       FROM requested r
       LEFT JOIN tab_configs tc
         ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name`,
    [pairs.map(p => p.sheetId), pairs.map(p => p.tabName)]
  );
  const configMap = new Map((configs || []).map(row => [pairKey(row.sheetId, row.tabName), row]));
  const campaignMap = await cashReceiptRequirementsForTabs(pairs, {
    client: db,
    strict: true,
    fresh: true,
  });

  const required = [];
  for (const row of source) {
    const pKey = pairKey(row.sheetId, row.tabName);
    const cfg = configMap.get(pKey) || {};
    const campaignRequired = campaignMap.get(pKey) === true;
    const info = cashReceiptSlotInfo(
      cfg.captureSlots,
      cfg.incomeType,
      campaignRequired
    );
    const isReceiptTarget = campaignRequired || info.incomeSaysCashReceipt || !!info.slot;
    const rKey = rowKey(row.sheetId, row.tabName, row.rowIndex);
    states.set(rKey, {
      required: isReceiptTarget,
      configured: !isReceiptTarget || !!(info.slot && info.slot.key),
      submitted: false,
    });
    if (!isReceiptTarget) continue;
    // 현영으로 표시됐는데 슬롯이 잘못 설정된 경우도 지급을 보류한다.
    if (!info.slot || !info.slot.key) continue;
    const index = Number(row.rowIndex);
    if (!Number.isInteger(index)) {
      states.set(rKey, { required: true, configured: false, submitted: false });
      continue;
    }
    required.push({
      sheetId: row.sheetId,
      tabName: row.tabName,
      rowIndex: index,
      receiptKey: String(info.slot.key),
    });
  }

  if (!required.length) return states;

  const { rows: submittedRows } = await db.query(
    `WITH requested AS (
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[], $4::text[])
         AS r(sheet_id, tab_name, row_index, receipt_key)
     )
     SELECT r.sheet_id AS "sheetId", r.tab_name AS "tabName", r.row_index AS "rowIndex"
       FROM requested r
      WHERE EXISTS (
        SELECT 1
          FROM review_submissions rs
         WHERE rs.sheet_id = r.sheet_id
           AND rs.tab_name = r.tab_name
           AND rs.row_index = r.row_index
           AND rs.slot_key = r.receipt_key
           AND btrim(COALESCE(rs.file_id, '')) <> ''
      )`,
    [
      required.map(r => r.sheetId),
      required.map(r => r.tabName),
      required.map(r => r.rowIndex),
      required.map(r => r.receiptKey),
    ]
  );
  const submitted = new Set((submittedRows || []).map(row => rowKey(row.sheetId, row.tabName, row.rowIndex)));
  for (const key of submitted) {
    const state = states.get(key);
    if (state) state.submitted = true;
  }

  return states;
}

async function filterReceiptEligiblePaymentRows(db, rows) {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) return [];
  const states = await cashReceiptSubmissionStates(db, source);

  return source.filter(row => {
    const key = rowKey(row.sheetId, row.tabName, row.rowIndex);
    const state = states.get(key);
    return !state || !state.required || (state.configured && state.submitted);
  });
}

module.exports = { filterReceiptEligiblePaymentRows, cashReceiptSubmissionStates, cashReceiptSubmissionRowKey: rowKey };
