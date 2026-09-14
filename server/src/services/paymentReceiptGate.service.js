'use strict';

/**
 * 현금영수증 대상 작업의 입금 게이트.
 *
 * 입금목록 API와 회차 생성은 반드시 이 함수를 거친다. 현금영수증 대상 여부는
 * captureSlots 공용 규칙으로 판정하고, 실제 제출 여부는 review_submissions의 현재 slot_key로
 * 확인한다. 조회 실패 시 대상을 추측해 지급하지 않도록 예외를 그대로 올린다.
 */
const { cashReceiptSlotInfo } = require('../utils/captureSlots');
const { cashReceiptRequirementsForRows } = require('./cashReceiptContext.service');

const pairKey = (sheetId, tabName) => `${sheetId}\u0000${tabName}`;
const rowKey = (sheetId, tabName, rowIndex) => `${sheetId}\u0000${tabName}\u0000${rowIndex}`;

async function cashReceiptSubmissionStates(db, rows, { lock = false } = {}) {
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

  if (lock) {
    const lockParams = [pairs.map(p => p.sheetId), pairs.map(p => p.tabName)];
    const lockRows = source.map(row => ({
      sheetId: row.sheetId, tabName: row.tabName, rowIndex: Number(row.rowIndex),
    }));
    if (lockRows.some(row => !Number.isInteger(row.rowIndex))) {
      throw new Error('cash receipt lock requires integer rowIndex');
    }
    const rowParams = [
      lockRows.map(r => r.sheetId), lockRows.map(r => r.tabName), lockRows.map(r => r.rowIndex),
    ];
    // 설정 변경도 지급 판정의 일부다. 기존 행을 직접 잠그고, 신규 삽입·연결 변경 같은
    // phantom은 호출 transaction의 SERIALIZABLE 격리가 충돌로 중단시킨다.
    await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[]) AS r(sheet_id, tab_name)
       )
       SELECT tc.sheet_id
         FROM requested r
         JOIN tab_configs tc ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
        FOR UPDATE OF tc`,
      lockParams
    );
    await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
           AS r(sheet_id, tab_name, row_index)
       )
       SELECT os.id
         FROM requested r
         JOIN order_submissions os
           ON os.sheet_id = r.sheet_id AND os.tab_name = r.tab_name
          AND os.sheet_row = r.row_index AND os.deleted_at IS NULL
        ORDER BY os.id
        FOR UPDATE OF os`,
      rowParams
    );
    await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
           AS r(sheet_id, tab_name, row_index)
       )
       SELECT cp.id
         FROM requested r
         JOIN campaign_participants cp
           ON cp.sheet_id = r.sheet_id AND cp.tab_name = r.tab_name AND cp.seq = r.row_index
          AND cp.deleted_at IS NULL AND cp.active = TRUE
        ORDER BY cp.id
        FOR UPDATE OF cp`,
      rowParams
    );
    await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
           AS r(sheet_id, tab_name, row_index)
       ), source_orders AS (
         SELECT os.id, os.campaign_application_id
           FROM requested r
           JOIN order_submissions os
             ON os.sheet_id = r.sheet_id AND os.tab_name = r.tab_name
            AND os.sheet_row = r.row_index AND os.deleted_at IS NULL
         UNION
         SELECT os.id, os.campaign_application_id
           FROM requested r
           JOIN campaign_participants cp
             ON cp.sheet_id = r.sheet_id AND cp.tab_name = r.tab_name AND cp.seq = r.row_index
            AND cp.deleted_at IS NULL AND cp.active = TRUE
           JOIN order_submissions os ON os.id = cp.order_submission_id AND os.deleted_at IS NULL
       )
       SELECT ca.id
         FROM campaign_applications ca
        WHERE EXISTS (
          SELECT 1 FROM source_orders so
           WHERE ca.id = so.campaign_application_id OR ca.order_submission_id = so.id
        )
        ORDER BY ca.id
        FOR UPDATE OF ca`,
      rowParams
    );
    await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
           AS r(sheet_id, tab_name, row_index)
       ), exact_campaigns AS (
         SELECT ca.campaign_id
           FROM requested r
           JOIN order_submissions os
             ON os.sheet_id = r.sheet_id AND os.tab_name = r.tab_name
            AND os.sheet_row = r.row_index AND os.deleted_at IS NULL
           JOIN campaign_applications ca
             ON ca.id = os.campaign_application_id OR ca.order_submission_id = os.id
         UNION
         SELECT ca.campaign_id
           FROM requested r
           JOIN campaign_participants cp
             ON cp.sheet_id = r.sheet_id AND cp.tab_name = r.tab_name AND cp.seq = r.row_index
            AND cp.deleted_at IS NULL AND cp.active = TRUE
           JOIN order_submissions os ON os.id = cp.order_submission_id AND os.deleted_at IS NULL
           JOIN campaign_applications ca
             ON ca.id = os.campaign_application_id OR ca.order_submission_id = os.id
       )
       SELECT rc.id
         FROM recruit_campaigns rc
        WHERE rc.id IN (SELECT campaign_id FROM exact_campaigns)
           OR EXISTS (
             SELECT 1 FROM requested r
             LEFT JOIN tab_configs tc ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
              WHERE rc.linked_sheet_id = r.sheet_id
                AND (rc.linked_tab_name = r.tab_name
                     OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
           )
        ORDER BY rc.id
        FOR UPDATE OF rc`,
      rowParams
    );
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
  const campaignMap = await cashReceiptRequirementsForRows(source, {
    client: db,
    strict: true,
    fresh: true,
  });

  const required = [];
  for (const row of source) {
    const pKey = pairKey(row.sheetId, row.tabName);
    const rKey = rowKey(row.sheetId, row.tabName, row.rowIndex);
    const cfg = configMap.get(pKey) || {};
    const campaignRequired = campaignMap.get(rKey) === true;
    const info = cashReceiptSlotInfo(
      cfg.captureSlots,
      cfg.incomeType,
      campaignRequired
    );
    const isReceiptTarget = campaignRequired || info.incomeSaysCashReceipt || !!info.slot;
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

  // 입금 완료 처리는 검증 후 원장을 쓰기까지 영수증 제출/검수 상태가 바뀌면 안 된다.
  // 좌표에 맞는 제출 행과 그 파일의 검수 행을 같은 transaction에서 잠그면 반려·교체·수동 이동이
  // 입금 기록 전에 끌어들어오는 READ COMMITTED 경쟁을 막는다.
  if (lock) {
    const lockParams = [
      required.map(r => r.sheetId),
      required.map(r => r.tabName),
      required.map(r => r.rowIndex),
      required.map(r => r.receiptKey),
    ];
    const { rows: lockedSubmissions } = await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[], $4::text[])
           AS r(sheet_id, tab_name, row_index, receipt_key)
       )
       SELECT rs.file_id
         FROM requested r
         JOIN review_submissions rs
           ON rs.sheet_id = r.sheet_id
          AND rs.tab_name = r.tab_name
          AND rs.row_index = r.row_index
          AND rs.slot_key = r.receipt_key
          AND btrim(COALESCE(rs.file_id, '')) <> ''
        FOR UPDATE OF rs`,
      lockParams
    );
    const fileIds = [...new Set((lockedSubmissions || []).map(r => String(r.file_id || '')).filter(Boolean))];
    if (fileIds.length) {
      await db.query(
        `SELECT file_id FROM review_inspections
          WHERE file_id = ANY($1::text[])
          FOR UPDATE`,
        [fileIds]
      );
    }
  }

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
           AND EXISTS (
             SELECT 1
               FROM review_inspections ri
              WHERE ri.file_id = rs.file_id
                AND (
                  -- 신규 제출: 업로드 시 수행한 영수증 전용 판정이 성공했고 다른 검수도 통과.
                  (ri.status = 'pass'
                   AND ri.checks->'receiptValidation'->>'verdict' = 'pass')
                  -- AI가 판정하지 못한 건은 내부 담당자가 실제 파일을 확인해 정상 종결해야 한다.
                  OR (ri.status = 'resolved' AND ri.resolution = 'ok'
                      AND COALESCE(ri.checks, '{}'::jsonb) ? 'receiptValidation')
                )
           )
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

async function filterReceiptEligiblePaymentRows(db, rows, options = {}) {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) return [];
  const states = await cashReceiptSubmissionStates(db, source, options);

  return source.filter(row => {
    const key = rowKey(row.sheetId, row.tabName, row.rowIndex);
    const state = states.get(key);
    return !state || !state.required || (state.configured && state.submitted);
  });
}

module.exports = { filterReceiptEligiblePaymentRows, cashReceiptSubmissionStates, cashReceiptSubmissionRowKey: rowKey };
