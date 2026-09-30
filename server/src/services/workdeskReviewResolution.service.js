'use strict';

const CLOSED_LABEL = '미작성 종결';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code, message) {
  const error = new Error(message); error.code = code; error.status = 409; return error;
}

// Called inside the existing cancellation transaction as well as manual closure.
async function recordResolution(client, row, resolution, by, reason) {
  if (resolution==='closed_no_review' && !UUID.test(String(row.review_participation_id||''))) {
    throw fail('identity_missing','참여 식별정보가 없습니다. 새로고침 후 다시 확인해 주세요.');
  }
  await client.query(`INSERT INTO workdesk_review_resolutions
    (participant_id,sheet_id,tab_name,row_index,order_submission_id,identity_key,
     participant_source,first_seen_at,resolution,reason,resolved_by,review_participation_id,history)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,
      jsonb_build_array(jsonb_build_object('resolution',$9::text,'reason',$10::text,'by',$11::text,'at',NOW(),'participationId',$12::uuid::text)))
    ON CONFLICT(participant_id) DO UPDATE SET
      sheet_id=EXCLUDED.sheet_id,tab_name=EXCLUDED.tab_name,row_index=EXCLUDED.row_index,
      order_submission_id=EXCLUDED.order_submission_id,identity_key=EXCLUDED.identity_key,
      participant_source=EXCLUDED.participant_source,first_seen_at=EXCLUDED.first_seen_at,
      review_participation_id=EXCLUDED.review_participation_id,
      resolution=EXCLUDED.resolution,reason=EXCLUDED.reason,resolved_by=EXCLUDED.resolved_by,
      resolved_at=NOW(),history=workdesk_review_resolutions.history||EXCLUDED.history`,
  [row.id,row.sheet_id,row.tab_name,row.seq,row.order_submission_id||null,row.identity_key||null,
    row.source||null,row.first_seen_at||null,resolution,reason,String(by||'admin').slice(0,100),row.review_participation_id||null]);
}

async function closeWithoutReview({ db, sheetId, tabName, rowId, expectedRevision, confirm, by, deriveAnchor }) {
  if (!sheetId || !tabName || !UUID.test(String(rowId || '')) || confirm !== true || !expectedRevision) {
    throw fail('confirmation_required', '선택한 행과 종결 내용을 확인한 뒤 다시 실행해 주세요.');
  }
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    // Match cancellation's lock order: order first, participant second.
    const peek=(await c.query('SELECT order_submission_id FROM campaign_participants WHERE id=$1 AND sheet_id=$2 AND tab_name=$3', [rowId,sheetId,tabName])).rows[0];
    if (!peek) throw fail('row_not_found','선택한 참여행이 없습니다.');
    if (peek.order_submission_id) {
      const locked=await c.query('SELECT id FROM order_submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[peek.order_submission_id]);
      if (!locked.rows.length) throw fail('order_cancelled','이미 취소된 주문입니다.');
    }
    const row=(await c.query(`SELECT cp.*,cp.updated_at::text AS revision FROM campaign_participants cp
      WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND active=TRUE AND deleted_at IS NULL FOR UPDATE`,[rowId,sheetId,tabName])).rows[0];
    if (!row || row.revision!==expectedRevision || (row.order_submission_id||null)!==(peek.order_submission_id||null)) {
      throw fail('row_changed','행이 변경되었습니다. 새로고침 후 다시 선택해 주세요.');
    }
    if (!row.order_submission_id && !row.identity_key && row.source!=='manual') {
      throw fail('identity_missing','참여 식별정보가 없어 종결할 수 없습니다. 주문 연결을 확인해 주세요.');
    }
    const existing=await c.query(`SELECT 1 FROM review_closed_targets WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3`,[sheetId,tabName,row.seq]);
    if (existing.rows.length) { await c.query('COMMIT'); return {ok:true,alreadyClosed:true}; }
    const config=(await c.query('SELECT is_closed,sheetless,archived_rounds FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 FOR SHARE',[sheetId,tabName])).rows[0];
    const archived=await c.query('SELECT 1 FROM index_master_archive WHERE sheet_id=$1 AND tab_name=$2',[sheetId,tabName]);
    const archivedRound=String(row.round||'').trim() && String(config?.archived_rounds||'').split(',').map(s=>s.trim()).includes(String(row.round).trim());
    if (!config || config.is_closed || archived.rows.length || archivedRound) throw fail('archived','보관되거나 닫힌 작업은 여기서 변경할 수 없습니다.');
    if (config.sheetless !== true) throw fail('not_sheetless','무시트 작업에서만 종결할 수 있습니다.');
    const ri=(await c.query(`SELECT id,is_submitted2 FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 FOR UPDATE`,[sheetId,tabName,row.seq])).rows[0];
    if (!ri) throw fail('review_history_missing','리뷰 원장 연결을 확인해 주세요.');
    if (row.is_paid || ri.is_submitted2==='PAID') throw fail('already_paid','입금 완료 건은 종결할 수 없습니다. 정산 내역을 먼저 확인해 주세요.');
    const batches=await c.query(`SELECT 1 FROM payment_batch_items WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND status IN ('pending','paid') LIMIT 1`,[sheetId,tabName,row.seq]);
    if (batches.rows.length) throw fail('payment_in_progress','이체 처리 중이거나 입금된 건입니다. 정산 내역을 먼저 확인해 주세요.');
    const files=await c.query(`SELECT 1 FROM review_submissions WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND slot_key='review' AND completed_at IS NOT NULL LIMIT 1`,[sheetId,tabName,row.seq]);
    if (files.rows.length) throw fail('review_record_exists','완료된 리뷰 첨부가 있습니다. 제출 내역을 먼저 확인해 주세요.');
    const fulfilled=await c.query(`SELECT 1 FROM reviewer_participations WHERE campaign_participant_id=$1
      AND lifecycle_status='active' AND review_obligation_status='fulfilled' LIMIT 1`,[row.id]);
    if(fulfilled.rows.length) throw fail('review_record_exists','보존된 제출 완료 기록이 있습니다. 종결할 수 없습니다.');
    const header=String(row.submit_col||'').trim() || await require('./sheetlessStatus.service').statusHeaderForTab(c,{sheetId,tabName,kind:'submit'});
    if (!header) throw fail('submit_column_missing','리뷰제출 열을 확인할 수 없습니다.');
    const anchor=deriveAnchor(row);
    if (!anchor) throw fail('identity_missing','참여 식별정보를 확인할 수 없습니다.');
    if (anchor.type!=='manual') {
      const others=await c.query(`SELECT id FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2
        AND active=TRUE AND deleted_at IS NULL AND id<>$3
        AND (($4='order' AND order_submission_id::text=$5) OR ($4='identity' AND identity_key=$5))`,[sheetId,tabName,row.id,anchor.type,anchor.value]);
      if (others.rows.length) throw fail('ambiguous_participant','같은 참여에 연결된 행이 여러 개입니다. 중복 연결을 먼저 확인해 주세요.');
    }
    const edits=(await c.query(`SELECT anchor_type,anchor_value,field,kind,value_text,value_bool FROM participant_edits
      WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL
      AND ((anchor_type=$3 AND anchor_value=$4) OR (anchor_type='manual' AND anchor_value=$5))`,[sheetId,tabName,anchor.type,anchor.value,String(row.id)])).rows;
    let value=row.row_json && row.row_json[header];
    for(const type of ['manual',anchor.type]) for(const e of edits) {
      if(e.anchor_type===type && e.field==='col:'+header) value=e.kind==='bool'?e.value_bool:e.value_text;
    }
    // Old "미제출" can be explicitly confirmed as terminal here, never auto-migrated.
    if (!['','false','미제출'].includes(String(value??'').trim().toLowerCase())) {
      throw fail('review_record_exists','리뷰제출 기록이 있습니다. 제출 내역을 확인한 뒤 처리해 주세요.');
    }
    await recordResolution(c,row,'closed_no_review',by,'admin_confirmed_long_overdue');
    await c.query(`UPDATE participant_edits SET reverted_at=NOW(),reverted_by=$1 WHERE sheet_id=$2 AND tab_name=$3
      AND reverted_at IS NULL AND field=ANY($4::text[])
      AND ((anchor_type=$5 AND anchor_value=$6) OR (anchor_type='manual' AND anchor_value=$7))`,
    [String(by||'admin').slice(0,100),sheetId,tabName,['col:'+header,'is_submitted'],anchor.type,anchor.value,String(row.id)]);
    await c.query(`UPDATE campaign_participants SET is_submitted=FALSE,
      row_json=coalesce(row_json,'{}'::jsonb)||jsonb_build_object($2::text,$3::text),updated_at=NOW(),updated_by=$4 WHERE id=$1`,[rowId,header,CLOSED_LABEL,String(by||'admin').slice(0,100)]);
    await c.query(`UPDATE review_index SET is_submitted=FALSE,
      row_json=coalesce(row_json,'{}'::jsonb)||jsonb_build_object($2::text,$3::text),built_at=NOW() WHERE id=$1`,[ri.id,header,CLOSED_LABEL]);
    if(row.order_submission_id) await c.query(`UPDATE review_reminder_states SET review_status='closed_no_review',closed_at=NOW(),close_reason='admin_confirmed_long_overdue',updated_at=NOW() WHERE order_submission_id=$1`,[row.order_submission_id]);
    await c.query(`UPDATE index_master SET submitted_count=(SELECT count(*) FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND is_submitted=TRUE) WHERE sheet_id=$1 AND tab_name=$2`,[sheetId,tabName]);
    await c.query('COMMIT'); return {ok:true,resolution:'closed_no_review'};
  } catch(e) {try{await c.query('ROLLBACK')}catch(_){} throw e;} finally {c.release();}
}

module.exports={CLOSED_LABEL,closeWithoutReview,recordResolution};
