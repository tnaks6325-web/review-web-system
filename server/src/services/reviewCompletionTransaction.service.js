'use strict';

function fail(code,message){return Object.assign(new Error(message),{code});}

// Match cancellation: order -> participant -> index. The caller owns COMMIT/ROLLBACK.
async function lockTarget(client,{sheetId,tabName,rowIndex,reviewerSession}) {
  const params=[sheetId,tabName,rowIndex];
  const peek=(await client.query(`SELECT id,order_submission_id FROM campaign_participants
    WHERE sheet_id=$1 AND tab_name=$2 AND seq=$3 AND active=TRUE AND deleted_at IS NULL`,params)).rows;
  for(const p of [...peek].sort((a,b)=>String(a.order_submission_id).localeCompare(String(b.order_submission_id)))) {
    if(!p.order_submission_id) continue;
    const order=await client.query('SELECT id FROM order_submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[p.order_submission_id]);
    if(!order.rows.length) throw fail('REVIEW_TARGET_CHANGED','취소되거나 변경된 참여입니다. 내역을 다시 불러와 주세요.');
  }
  const locked=(await client.query(`SELECT id,order_submission_id,round,submit_col,row_json FROM campaign_participants
    WHERE sheet_id=$1 AND tab_name=$2 AND seq=$3 AND active=TRUE AND deleted_at IS NULL ORDER BY id FOR UPDATE`,params)).rows;
  if(peek.length!==locked.length || peek.some(p=>!locked.some(r=>r.id===p.id && r.order_submission_id===p.order_submission_id))) {
    throw fail('REVIEW_TARGET_CHANGED','참여 정보가 변경되었습니다. 내역을 다시 불러와 주세요.');
  }
  const config=(await client.query('SELECT is_closed,archived_rounds,sheetless FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 FOR SHARE',params.slice(0,2))).rows[0];
  if(config?.sheetless && !locked.length) throw fail('REVIEW_TARGET_CHANGED','활성 참여행이 없습니다. 내역을 다시 불러와 주세요.');
  const rounds=String(config?.archived_rounds||'').split(',').map(s=>s.trim()).filter(Boolean);
  const archive=await client.query('SELECT 1 FROM index_master_archive WHERE sheet_id=$1 AND tab_name=$2',params.slice(0,2));
  if(!config || config.is_closed || archive.rows.length || locked.some(r=>rounds.includes(String(r.round||'').trim()))) {
    throw fail('REVIEW_TARGET_ARCHIVED','마감된 작업에는 리뷰를 제출할 수 없습니다.');
  }
  const closed=await client.query('SELECT 1 FROM review_closed_targets WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3',params);
  if(closed.rows.length) throw fail('REVIEW_CLOSED_NO_REVIEW','미작성으로 종결된 작업입니다.');
  if(locked.some(r=>['미제출','미작성 종결','취소건'].includes(String(r.row_json?.[r.submit_col]??'').trim()))) {
    throw fail('REVIEW_LEGACY_RESOLUTION_PENDING','과거 종결·취소 기록이 있습니다. 관리자에게 처리 내역 확인을 요청해 주세요.');
  }
  const index=(await client.query('SELECT id,is_submitted,round FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 FOR UPDATE',params)).rows[0];
  if(!index) throw fail('REVIEW_TARGET_CHANGED','제출 대상이 변경되었습니다. 내역을 다시 불러와 주세요.');
  if(rounds.includes(String(index.round||'').trim())) throw fail('REVIEW_TARGET_ARCHIVED','마감된 차수에는 리뷰를 제출할 수 없습니다.');
  if(reviewerSession && !await require('./reviewerTargetOwnership.service').ownsReviewerTarget({session:reviewerSession,sheetId,tabName,rowIndex,client})) {
    throw fail('REVIEW_SUBMIT_TARGET_FORBIDDEN','참여 정보가 변경되어 리뷰를 제출할 수 없습니다.');
  }
  return index;
}
module.exports={lockTarget};
