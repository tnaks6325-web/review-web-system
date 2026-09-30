'use strict';

const pool=require('../db/pool');
const candidatesSql=`SELECT cp.id,cp.updated_at::text AS revision,cp.sheet_id,cp.tab_name,cp.seq,
  cp.owner_reviewer_id,os.owner_reviewer_id AS candidate_owner,
  CASE WHEN (cp.owner_reviewer_id IS NOT NULL AND os.owner_reviewer_id IS NOT NULL AND cp.owner_reviewer_id<>os.owner_reviewer_id)
      OR EXISTS(SELECT 1 FROM campaign_applications ca WHERE ca.id=os.campaign_application_id
      AND ca.owner_reviewer_id IS NOT NULL AND ca.owner_reviewer_id<>os.owner_reviewer_id)
      OR EXISTS(SELECT 1 FROM participation_links pl WHERE pl.sheet_id=cp.sheet_id AND pl.tab_name=cp.tab_name AND pl.row_index=cp.seq
        AND pl.owner_reviewer_id IS NOT NULL AND pl.owner_reviewer_id<>os.owner_reviewer_id) THEN 'conflict'
    WHEN EXISTS(SELECT 1 FROM campaign_participants other WHERE other.sheet_id=cp.sheet_id AND other.tab_name=cp.tab_name
      AND other.order_submission_id=cp.order_submission_id AND other.id<>cp.id AND other.active=TRUE AND other.deleted_at IS NULL) THEN 'duplicate_order'
    WHEN cp.owner_reviewer_id IS NOT NULL THEN 'already_owned'
    WHEN os.owner_reviewer_id IS NULL OR v.id IS NULL OR NULLIF(os.participant_identity_key_hash,'') IS NULL THEN 'unresolved'
    ELSE 'verified_order' END AS decision
 FROM campaign_participants cp
 LEFT JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
 LEFT JOIN reviewers v ON v.id=os.owner_reviewer_id
 JOIN tab_configs tc ON tc.sheet_id=cp.sheet_id AND tc.tab_name=cp.tab_name
 WHERE cp.active=TRUE AND cp.deleted_at IS NULL AND NOT COALESCE(tc.is_closed,FALSE)
   AND (NULLIF(btrim(cp.round),'') IS NULL OR NOT (btrim(cp.round)=ANY(regexp_split_to_array(btrim(COALESCE(tc.archived_rounds,'')),'[[:space:]]*,[[:space:]]*'))))
   AND NOT EXISTS(SELECT 1 FROM index_master_archive a WHERE a.sheet_id=cp.sheet_id AND a.tab_name=cp.tab_name)
   AND NOT EXISTS(SELECT 1 FROM trackb_tab_finished f WHERE f.sheet_id=cp.sheet_id AND f.tab_name=cp.tab_name AND f.deleted_at IS NULL)
   AND (cp.order_submission_id IS NOT NULL OR NULLIF(cp.reviewer_name,'') IS NOT NULL OR NULLIF(cp.phone8,'') IS NOT NULL)`;

async function preview({after=null,limit=100}={},db=pool) {
  const {rows}=await db.query(`${candidatesSql} AND ($1::uuid IS NULL OR cp.id>$1::uuid) ORDER BY cp.id LIMIT $2`,[after,Math.min(500,Math.max(1,Number(limit)||100))]);
  return {ok:true,items:rows,next:rows.length?rows[rows.length-1].id:null};
}
async function applyVerified({rowId,expectedRevision,confirm,by},db=pool) {
  if(confirm!==true||!rowId||!expectedRevision||!by) throw new Error('확인한 행·버전·처리자가 필요합니다.');
  const c=await db.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.review_actor',$1,true)",[String(by)]);
    const peek=(await c.query('SELECT order_submission_id FROM campaign_participants WHERE id=$1',[rowId])).rows[0];
    if(!peek||!peek.order_submission_id) throw new Error('연결된 주문이 없습니다.');
    await c.query('SELECT id FROM order_submissions WHERE id=$1 FOR SHARE',[peek.order_submission_id]);
    const row=(await c.query('SELECT id,updated_at::text AS revision FROM campaign_participants WHERE id=$1 FOR UPDATE',[rowId])).rows[0];
    if(!row||row.revision!==expectedRevision) throw new Error('행이 변경되어 보정을 중단했습니다.');
    const candidate=(await c.query(`${candidatesSql} AND cp.id=$1 AND cp.order_submission_id=$2`,[rowId,peek.order_submission_id])).rows[0];
    if(!candidate||candidate.decision!=='verified_order') throw new Error('자동 보정 근거가 없거나 충돌합니다.');
    // Materialize before the owner change so the audit includes the unresolved state.
    await c.query('SELECT refresh_reviewer_participation($1)',[rowId]);
    await c.query('UPDATE campaign_participants SET owner_reviewer_id=$2,updated_at=now(),updated_by=$3 WHERE id=$1 AND owner_reviewer_id IS NULL',
      [rowId,candidate.candidate_owner,String(by).slice(0,100)]);
    await c.query('COMMIT'); return {ok:true,rowId,ownerReviewerId:candidate.candidate_owner};
  } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
}
async function projectBatch({after=null,limit=100,confirm,by},db=pool) {
  if(confirm!==true||!by) throw new Error('참여 원장 적재 확인이 필요합니다.');
  const c=await db.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.review_actor',$1,true)",[String(by)]);
    const {rows}=await c.query(`SELECT id FROM campaign_participants WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2 FOR UPDATE`,[after,Math.min(500,Math.max(1,Math.trunc(Number(limit)||100)))]);
    for(const r of rows) await c.query('SELECT refresh_reviewer_participation($1)',[r.id]);
    await c.query('COMMIT'); return {ok:true,count:rows.length,next:rows.length?rows[rows.length-1].id:null};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
// Manual mapping is a separate operator decision, never a name/phone inference.
// No HTTP route exposes this administrative migration tool.
async function assignReviewedOwner({rowId,ownerReviewerId,expectedRevision,evidence,confirm=false,by},db=pool) {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(String(rowId||''))||!uuid.test(String(ownerReviewerId||''))||!expectedRevision||!String(evidence||'').trim()||!by) {
    throw new Error('참여행 ID·등록 리뷰어 ID·행 버전·확인 근거·담당자를 지정해 주세요.');
  }
  const c=await db.connect();
  try {
    await c.query('BEGIN');await c.query("SELECT set_config('app.review_actor',$1,true)",[String(by)]);
    const peek=(await c.query('SELECT order_submission_id FROM campaign_participants WHERE id=$1',[rowId])).rows[0];
    if(!peek) throw new Error('참여행이 없습니다.');
    if(peek.order_submission_id) await c.query('SELECT id FROM order_submissions WHERE id=$1 FOR SHARE',[peek.order_submission_id]);
    const row=(await c.query('SELECT *,updated_at::text AS revision FROM campaign_participants WHERE id=$1 FOR UPDATE',[rowId])).rows[0];
    if(!row||row.revision!==expectedRevision||(row.order_submission_id||null)!==(peek.order_submission_id||null)) throw new Error('행이 변경되었습니다. 다시 확인해 주세요.');
    const candidate=(await c.query(`${candidatesSql} AND cp.id=$1`,[rowId])).rows[0];
    if(!candidate||candidate.owner_reviewer_id||['conflict','duplicate_order'].includes(candidate.decision)) throw new Error('기존 귀속·중복·마감 또는 충돌이 있어 수동 보정을 중단했습니다.');
    const conflicts=await c.query(`SELECT 1 FROM order_submissions os LEFT JOIN campaign_applications ca ON ca.id=os.campaign_application_id
      WHERE os.id=$1 AND (os.deleted_at IS NOT NULL OR (os.owner_reviewer_id IS NOT NULL AND os.owner_reviewer_id<>$2)
        OR (ca.owner_reviewer_id IS NOT NULL AND ca.owner_reviewer_id<>$2))
      UNION ALL SELECT 1 FROM participation_links pl WHERE pl.sheet_id=$3 AND pl.tab_name=$4 AND pl.row_index=$5
        AND pl.owner_reviewer_id IS NOT NULL AND pl.owner_reviewer_id<>$2`,[row.order_submission_id,ownerReviewerId,row.sheet_id,row.tab_name,row.seq]);
    if(conflicts.rows.length) throw new Error('연결된 주문·신청·참여 링크의 소유자와 충돌합니다.');
    if(row.participant_identity_id){
      const identity=await c.query('SELECT owner_reviewer_id FROM reviewer_identities WHERE id=$1',[row.participant_identity_id]);
      if(!identity.rows.length||String(identity.rows[0].owner_reviewer_id)!==String(ownerReviewerId)) throw new Error('참여 명의의 소유자와 일치하지 않습니다.');
    }
    const reviewer=await c.query('SELECT id FROM reviewers WHERE id=$1 FOR SHARE',[ownerReviewerId]);
    if(!reviewer.rows.length) throw new Error('등록 리뷰어가 없습니다.');
    if(!confirm){await c.query('ROLLBACK');return {ok:true,dryRun:true,rowId,ownerReviewerId};}
    await c.query('SELECT refresh_reviewer_participation($1)',[rowId]);
    await c.query(`INSERT INTO reviewer_owner_mapping_reviews(participant_id,owner_reviewer_id,evidence,reviewed_by,previous_revision)
      VALUES($1,$2,$3,$4,$5)`,[rowId,ownerReviewerId,String(evidence).trim().slice(0,2000),String(by).slice(0,100),expectedRevision]);
    await c.query('UPDATE campaign_participants SET owner_reviewer_id=$2,updated_at=now(),updated_by=$3 WHERE id=$1 AND owner_reviewer_id IS NULL',[rowId,ownerReviewerId,String(by).slice(0,100)]);
    await c.query("UPDATE reviewer_participations SET ownership_source='operator_review' WHERE campaign_participant_id=$1 AND lifecycle_status='active'",[rowId]);
    await c.query('COMMIT');return {ok:true,rowId,ownerReviewerId};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function disableOwner({ownerReviewerId,confirm=false,by},db=pool) {
  if(!ownerReviewerId||!by) throw new Error('소유자 ID와 담당자를 지정해 주세요.');
  if(!confirm) return {ok:true,dryRun:true,ownerReviewerId,action:'disable_owner_history'};
  const {rows}=await db.query(`UPDATE reviewer_history_rollouts SET enabled=FALSE,checked_by=$2,checked_at=now()
    WHERE owner_reviewer_id=$1 RETURNING owner_reviewer_id`,[ownerReviewerId,by]);
  return {ok:true,changed:rows.length===1};
}
// Narrow repair for the old SQL whitespace bug, not a general "reopen review" API.
// Completed uploads/payment evidence are never overridden by this tool.
async function repairInvalidFulfillment({participationId,expectedVersion,evidence,by,confirm=false},db=pool) {
  if(!participationId||!expectedVersion||!String(evidence||'').trim()||!String(by||'').trim()) {
    throw new Error('참여 ID·원장 버전·확인 근거·담당자가 필요합니다.');
  }
  const c=await db.connect();
  try {
    await c.query('BEGIN');await c.query("SELECT set_config('app.review_actor',$1,true)",[String(by)]);
    const peek=(await c.query('SELECT campaign_participant_id,order_submission_id FROM reviewer_participations WHERE id=$1',[participationId])).rows[0];
    if(!peek) throw new Error('참여 원장이 없습니다.');
    if(peek.order_submission_id) await c.query('SELECT id FROM order_submissions WHERE id=$1 FOR UPDATE',[peek.order_submission_id]);
    const cp=(await c.query('SELECT * FROM campaign_participants WHERE id=$1 FOR UPDATE',[peek.campaign_participant_id])).rows[0];
    const p=(await c.query('SELECT * FROM reviewer_participations WHERE id=$1 FOR UPDATE',[participationId])).rows[0];
    if(!cp||p.lifecycle_status!=='active'||String(p.record_version)!==String(expectedVersion)
      ||(cp.order_submission_id||null)!==(p.order_submission_id||null)) throw new Error('참여가 변경되거나 종료되었습니다. 다시 확인해 주세요.');
    if(!(await c.query(`${candidatesSql} AND cp.id=$1`,[cp.id])).rows.length) throw new Error('마감된 작업은 보정하지 않습니다.');
    const {classifyCell}=require('./reviewObligation.service');
    if(p.review_obligation_status!=='fulfilled'||classifyCell(p.review_evidence?.value,!!p.review_evidence?.header)==='fulfilled') {
      throw new Error('공백 오판정 근거가 없는 완료 건은 되돌릴 수 없습니다.');
    }
    const protectedRows=await c.query(`SELECT 1 FROM review_submissions WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND slot_key='review' AND completed_at IS NOT NULL
      UNION ALL SELECT 1 FROM payment_batch_items WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND status IN ('pending','paid')
      UNION ALL SELECT 1 FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND is_submitted2='PAID'`,[cp.sheet_id,cp.tab_name,cp.seq]);
    if(cp.is_paid||protectedRows.rows.length) throw new Error('첨부 완료·정산 기록이 있어 보정을 중단했습니다.');
    if(!confirm){await c.query('ROLLBACK');return {ok:true,dryRun:true,participationId};}
    await c.query(`UPDATE reviewer_participations SET review_obligation_status='pending',record_version=record_version+1,updated_at=now()
      WHERE id=$1`,[participationId]);
    await c.query('SELECT refresh_reviewer_participation($1)',[cp.id]);
    const corrected=(await c.query('SELECT review_obligation_status FROM reviewer_participations WHERE id=$1',[participationId])).rows[0];
    if(corrected.review_obligation_status==='fulfilled') throw new Error('현재 제출 기록이 있어 보정을 중단했습니다.');
    await c.query('UPDATE campaign_participants SET is_submitted=FALSE,updated_at=now(),updated_by=$2 WHERE id=$1',[cp.id,String(by).slice(0,100)]);
    await c.query('UPDATE review_index SET is_submitted=FALSE,built_at=now() WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3',[cp.sheet_id,cp.tab_name,cp.seq]);
    await c.query(`INSERT INTO reviewer_participation_events(participation_id,before_state,after_state,actor)
      VALUES($1,$2::jsonb,$3::jsonb,$4)`,[participationId,JSON.stringify({review:p.review_obligation_status,evidence:p.review_evidence}),
      JSON.stringify({review:corrected.review_obligation_status,reason:'invalid_cell_fulfillment_repair',evidence:String(evidence).trim().slice(0,2000)}),String(by)]);
    await c.query('COMMIT');return {ok:true,participationId,status:corrected.review_obligation_status};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
function compare(legacy,projected) {
  const key=r=>[r.sheetId,r.tabName,r.rowIndex].join('\u0000');
  const got=new Map(projected.filter(r=>!r.isOrderPending).map(r=>[key(r),r]));
  const missing=legacy.filter(r=>!r.isOrderPending&&!got.has(key(r))).map(key);
  const reopened=legacy.filter(r=>!r.isOrderPending&&r.isSubmitted&&got.has(key(r))&&!got.get(key(r)).isSubmitted).map(key);
  const pendingOrders=legacy.filter(r=>r.isOrderPending).length;
  const duplicateCoordinates=projected.length-got.size;
  return {missing,reopened,pendingOrders,duplicateCoordinates,eligible:!missing.length&&!reopened.length&&!pendingOrders&&!duplicateCoordinates};
}
async function certify({ownerReviewerId,legacy,projected,confirm,by,coverageEpoch},db=pool) {
  const comparison=compare(legacy,projected);
  if(confirm!==true||!by||!comparison.eligible) return {ok:false,comparison};
  const {rows}=await db.query(`INSERT INTO reviewer_history_rollouts(owner_reviewer_id,enabled,coverage_epoch,checked_by,comparison)
    SELECT $1,TRUE,coverage_epoch,$2,$3::jsonb FROM reviewer_history_control WHERE id=TRUE AND coverage_epoch=$4
    ON CONFLICT(owner_reviewer_id) DO UPDATE SET enabled=TRUE,coverage_epoch=EXCLUDED.coverage_epoch,
      checked_at=now(),checked_by=EXCLUDED.checked_by,comparison=EXCLUDED.comparison RETURNING owner_reviewer_id`,
    [ownerReviewerId,by,JSON.stringify(comparison),coverageEpoch]);
  return {ok:rows.length===1,comparison};
}
module.exports={preview,applyVerified,assignReviewedOwner,disableOwner,repairInvalidFulfillment,projectBatch,compare,certify,candidatesSql};
