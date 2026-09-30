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
// 작업 마감(trackb_tab_finished)은 담당자가 "이 작업은 끝났다"고 정한 것이다. 마감된 작업의
// 미제출 행을 리뷰어에게 "리뷰를 써야 하는 작업"으로 다시 보이거나 독촉하지 않는다.
// 이름 매칭 + gid 폴백(리네임 대비, 빈 gid 는 절을 켜지 않는다). 제출 완료 이력은 그대로 둔다.
function finishedTabSql(sheetExpr, tabExpr, gidExpr=null) {
  const gid=gidExpr ? ` OR (NULLIF(btrim(f.tab_gid),'') IS NOT NULL AND f.tab_gid=${gidExpr})` : '';
  return `EXISTS(SELECT 1 FROM trackb_tab_finished f WHERE f.deleted_at IS NULL
      AND f.sheet_id=${sheetExpr} AND (f.tab_name=${tabExpr}${gid}))`;
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
    AND NOT EXISTS(SELECT 1 FROM index_master_archive a WHERE a.sheet_id=${alias}.sheet_id AND a.tab_name=${alias}.tab_name)
    AND NOT ${finishedTabSql(`${alias}.sheet_id`,`${alias}.tab_name`,`${alias}.tab_gid`)}`;
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
module.exports={classifyCell,submittedSql,unfulfilledSql,finishedTabSql,isFulfilled,canRemind};
