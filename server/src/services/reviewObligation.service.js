'use strict';
const pool=require('../db/pool');
function classifyCell(value,hasHeader=true){
  if(!hasHeader) return 'unknown';
  const text=String(value??'').trim();
  if(['','false','미제출'].includes(text.toLowerCase())) return 'pending';
  if(['취소건','미작성 종결'].includes(text)) return 'unknown';
  return 'fulfilled';
}
function submittedSql(fallback, alias='ri', rowColumn='row_index') {
  return `COALESCE((SELECT rp.review_obligation_status='fulfilled'
    FROM reviewer_participations rp WHERE rp.sheet_id=${alias}.sheet_id AND rp.tab_name=${alias}.tab_name
      AND rp.row_index=${alias}.${rowColumn} AND rp.lifecycle_status='active' LIMIT 1), ${fallback})`;
}
function unfulfilledSql(alias='ri') {
  return `NOT EXISTS (SELECT 1 FROM reviewer_participations obligation
    WHERE obligation.sheet_id=${alias}.sheet_id AND obligation.tab_name=${alias}.tab_name
      AND obligation.row_index=${alias}.row_index AND obligation.lifecycle_status='active'
      AND obligation.review_obligation_status IN ('fulfilled','closed_no_review','unknown'))
    AND lower(review_cell_text(${alias}.row_json->>${alias}.submit_col)) NOT IN ('미제출','미작성 종결','취소건')
    AND NOT EXISTS(SELECT 1 FROM reviewer_participations obligation
      WHERE obligation.sheet_id=${alias}.sheet_id AND obligation.tab_name=${alias}.tab_name
        AND obligation.row_index=${alias}.row_index AND obligation.lifecycle_status='active'
        AND review_cell_text(obligation.review_evidence->>'value') IN ('미제출','미작성 종결','취소건'))
    AND NOT EXISTS(SELECT 1 FROM tab_configs tc WHERE tc.sheet_id=${alias}.sheet_id AND tc.tab_name=${alias}.tab_name
      AND (tc.is_closed OR (NULLIF(btrim(${alias}.round),'') IS NOT NULL AND btrim(${alias}.round)=ANY(regexp_split_to_array(btrim(COALESCE(tc.archived_rounds,'')),'[[:space:]]*,[[:space:]]*')))))
    AND NOT EXISTS(SELECT 1 FROM campaign_participants cp
      LEFT JOIN tab_configs tc ON tc.sheet_id=cp.sheet_id AND tc.tab_name=cp.tab_name
      WHERE cp.sheet_id=${alias}.sheet_id AND cp.tab_name=${alias}.tab_name AND cp.seq=${alias}.row_index
        AND (NOT cp.active OR cp.deleted_at IS NOT NULL OR (NULLIF(btrim(cp.round),'') IS NOT NULL
          AND btrim(cp.round)=ANY(regexp_split_to_array(btrim(COALESCE(tc.archived_rounds,'')),'[[:space:]]*,[[:space:]]*')))))
    AND NOT EXISTS(SELECT 1 FROM index_master_archive a WHERE a.sheet_id=${alias}.sheet_id AND a.tab_name=${alias}.tab_name)`;
}
async function canRemind({sheetId,tabName,rowIndex},db=pool) {
  const {rows}=await db.query(`SELECT 1 FROM review_index ri WHERE ri.sheet_id=$1 AND ri.tab_name=$2 AND ri.row_index=$3
    AND ri.is_submitted=FALSE AND ${unfulfilledSql('ri')} LIMIT 1`,[sheetId,tabName,rowIndex]);
  return rows.length>0;
}
async function isFulfilled({sheetId,tabName,rowIndex},db=pool) {
  const {rows}=await db.query(`SELECT id FROM reviewer_participations WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3
    AND lifecycle_status='active' AND review_obligation_status='fulfilled' LIMIT 1`,[sheetId,tabName,rowIndex]);
  return !!(rows[0]&&rows[0].id);
}
module.exports={classifyCell,submittedSql,unfulfilledSql,isFulfilled,canRemind};
