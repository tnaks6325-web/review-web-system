'use strict';

/**
 * 입금 금액이 보는 "현재 작업보드 표시값"의 단일 출처.
 *
 * 작업보드 표는 campaign_participants.row_json 위에 participant_edits를
 * 물리행(manual) -> 현재 앵커(order/manual/identity) 순서로 합성한다.
 * 입금관리도 같은 합성을 거쳐야 관리자 셀 편집이 주문 원장 금액에 가려지지 않는다.
 */
const { extractAmountNumber, isAmountCandidateHeader, EXACT_KEYS } = require('../utils/paymentAmount');

function _key(row) {
  return [String(row && row.sheetId || ''), String(row && row.tabName || ''), Number(row && row.rowIndex)].join('\t');
}

function _columnEdits(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [field, cellValue] of Object.entries(value)) {
    if (!String(field).startsWith('col:')) continue;
    const header = String(field).slice(4);
    if (isAmountCandidateHeader(header)) out[header] = cellValue == null ? '' : cellValue;
  }
  return out;
}

function resolveDisplayedAmount({ fallbackRowJson, participantRowJson, manualEdits, anchorEdits, ambiguous = false } = {}) {
  const physical = participantRowJson && typeof participantRowJson === 'object'
    ? participantRowJson
    : (fallbackRowJson && typeof fallbackRowJson === 'object' ? fallbackRowJson : {});
  // 작업보드와 동일하게 현재 order/identity 앵커가 여러 활성 행을 가리키면
  // 현재 앵커뿐 아니라 과거 물리행(manual) 편집도 전부 숨긴다.
  const manual = ambiguous ? {} : _columnEdits(manualEdits);
  const current = ambiguous ? {} : _columnEdits(anchorEdits);
  const merged = { ...physical, ...manual, ...current };
  const amount = extractAmountNumber(merged);
  const edited = Object.keys(manual).length > 0 || Object.keys(current).length > 0;
  return { amount, source: amount ? (edited ? 'workboard_edit' : 'workboard') : null, rowJson: merged };
}

/**
 * 여러 작업보드 행의 현재 표시금액을 한 번에 읽는다.
 * 반환 Map 키: sheetId\ttabName\trowIndex
 */
async function loadWorkboardAmounts(db, targetRows) {
  const targets = (Array.isArray(targetRows) ? targetRows : [])
    .filter(row => row && row.sheetId && row.tabName && Number.isInteger(Number(row.rowIndex)))
    .map(row => ({
      sheetId: String(row.sheetId), tabName: String(row.tabName), rowIndex: Number(row.rowIndex),
      fallbackRowJson: row.rowJson && typeof row.rowJson === 'object' ? row.rowJson : {},
    }));
  const out = new Map();
  for (const target of targets) out.set(_key(target), resolveDisplayedAmount({ fallbackRowJson: target.fallbackRowJson }));
  if (!targets.length) return out;

  const { rows } = await db.query(
    `WITH targets AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x("sheetId" text, "tabName" text, "rowIndex" integer)
     )
     SELECT t."sheetId", t."tabName", t."rowIndex",
            cp.row_json AS "participantRowJson",
            CASE
              WHEN cp.order_submission_id IS NOT NULL THEN
                (SELECT COUNT(*) FROM campaign_participants same_cp
                  WHERE same_cp.sheet_id = cp.sheet_id AND same_cp.tab_name = cp.tab_name
                    AND same_cp.deleted_at IS NULL AND same_cp.active = TRUE
                    AND same_cp.order_submission_id = cp.order_submission_id) > 1
              WHEN cp.source IS DISTINCT FROM 'manual' AND NULLIF(cp.identity_key, '') IS NOT NULL THEN
                (SELECT COUNT(*) FROM campaign_participants same_cp
                  WHERE same_cp.sheet_id = cp.sheet_id AND same_cp.tab_name = cp.tab_name
                    AND same_cp.deleted_at IS NULL AND same_cp.active = TRUE
                    AND same_cp.identity_key = cp.identity_key) > 1
              ELSE FALSE
            END AS "ambiguous",
            COALESCE((
              SELECT jsonb_object_agg(pe.field,
                       CASE WHEN pe.kind = 'bool' THEN to_jsonb(pe.value_bool) ELSE to_jsonb(pe.value_text) END)
                FROM participant_edits pe
               WHERE pe.sheet_id = cp.sheet_id AND pe.tab_name = cp.tab_name
                 AND pe.anchor_type = 'manual' AND pe.anchor_value = cp.id::text
                 AND pe.reverted_at IS NULL AND pe.field LIKE 'col:%'
            ), '{}'::jsonb) AS "manualEdits",
            COALESCE((
              SELECT jsonb_object_agg(pe.field,
                       CASE WHEN pe.kind = 'bool' THEN to_jsonb(pe.value_bool) ELSE to_jsonb(pe.value_text) END)
                FROM participant_edits pe
               WHERE pe.sheet_id = cp.sheet_id AND pe.tab_name = cp.tab_name
                 AND pe.reverted_at IS NULL AND pe.field LIKE 'col:%'
                 AND pe.anchor_type = CASE
                       WHEN cp.order_submission_id IS NOT NULL THEN 'order'
                       WHEN cp.source = 'manual' THEN 'manual'
                       WHEN NULLIF(cp.identity_key, '') IS NOT NULL THEN 'identity'
                       ELSE 'manual' END
                 AND pe.anchor_value = CASE
                       WHEN cp.order_submission_id IS NOT NULL THEN cp.order_submission_id::text
                       WHEN cp.source = 'manual' THEN cp.id::text
                       WHEN NULLIF(cp.identity_key, '') IS NOT NULL THEN cp.identity_key
                       ELSE cp.id::text END
                 AND (
                   cp.order_submission_id IS NULL
                   OR (SELECT COUNT(*) FROM campaign_participants same_cp
                        WHERE same_cp.sheet_id = cp.sheet_id AND same_cp.tab_name = cp.tab_name
                          AND same_cp.deleted_at IS NULL AND same_cp.active = TRUE
                          AND same_cp.order_submission_id = cp.order_submission_id) = 1
                 )
                 AND (
                   cp.order_submission_id IS NOT NULL OR cp.source = 'manual' OR NULLIF(cp.identity_key, '') IS NULL
                   OR (SELECT COUNT(*) FROM campaign_participants same_cp
                        WHERE same_cp.sheet_id = cp.sheet_id AND same_cp.tab_name = cp.tab_name
                          AND same_cp.deleted_at IS NULL AND same_cp.active = TRUE
                          AND same_cp.identity_key = cp.identity_key) = 1
                 )
            ), '{}'::jsonb) AS "anchorEdits"
       FROM targets t
       LEFT JOIN LATERAL (
         SELECT cp.* FROM campaign_participants cp
          WHERE cp.sheet_id = t."sheetId" AND cp.tab_name = t."tabName" AND cp.seq = t."rowIndex"
            AND cp.deleted_at IS NULL AND cp.active = TRUE
          ORDER BY cp.updated_at DESC, cp.id DESC LIMIT 1
       ) cp ON TRUE`,
    [JSON.stringify(targets.map(({ sheetId, tabName, rowIndex }) => ({ sheetId, tabName, rowIndex })))]
  );

  const fallbackByKey = new Map(targets.map(row => [_key(row), row.fallbackRowJson]));
  for (const row of rows) {
    out.set(_key(row), resolveDisplayedAmount({
      fallbackRowJson: fallbackByKey.get(_key(row)),
      participantRowJson: row.participantRowJson,
      manualEdits: row.manualEdits,
      anchorEdits: row.anchorEdits,
      ambiguous: row.ambiguous === true,
    }));
  }
  return out;
}

/** 현재 입금 후보가 속한 작업들의 제출완료 행 전체를 이상금액 비교 모집단으로 읽는다. */
async function loadWorkboardAmountPopulation(db, works) {
  const unique = [...new Map((works || []).filter(x => x && x.sheetId && x.tabName)
    .map(x => [String(x.sheetId) + '\t' + String(x.tabName), { sheetId: String(x.sheetId), tabName: String(x.tabName) }])).values()];
  if (!unique.length) return [];
  const { rows } = await db.query(
    `WITH works AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("sheetId" text, "tabName" text)
     )
     SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName", ri.row_index AS "rowIndex",
            (SELECT jsonb_object_agg(kv.key, kv.value)
               FROM jsonb_each_text(COALESCE(ri.row_json, '{}'::jsonb)) kv
              WHERE replace(kv.key, ' ', '') LIKE '%금액%'
                 OR replace(kv.key, ' ', '') = ANY($2)) AS "rowJson"
       FROM review_index ri
       JOIN works w ON w."sheetId" = ri.sheet_id AND w."tabName" = ri.tab_name
      WHERE ri.is_submitted = TRUE AND ri.row_index IS NOT NULL
      ORDER BY ri.sheet_id, ri.tab_name, ri.row_index
      LIMIT 10000`,
    [JSON.stringify(unique), EXACT_KEYS]
  );
  const amounts = await loadWorkboardAmounts(db, rows);
  return rows.map(row => ({
    sheetId: row.sheetId, tabName: row.tabName, rowIndex: row.rowIndex,
    productPrice: Number((amounts.get(_key(row)) || {}).amount || 0),
  })).filter(row => row.productPrice > 0);
}

module.exports = { loadWorkboardAmounts, loadWorkboardAmountPopulation, resolveDisplayedAmount, workboardAmountKey: _key };
