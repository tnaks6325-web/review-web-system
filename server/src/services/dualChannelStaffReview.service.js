'use strict';
const {loadBundle,identityEvidenceHash,fail}=require('./dualChannelReview.service');
function actorName(actor){const name=typeof actor==='string'?actor:actor?.username;if(!name||!String(name).trim())throw fail('staff_actor_required');return String(name);}
// InTx callers MUST acquire lifecycle scope before any row lock; wrappers below own that boundary.
async function resolveBundleIdentityReviewInTx({db,orderSubmissionId,expectedBundleHash,expectedArtifactRevisions,decision,note,actor,lockedScope}){
 if(lockedScope)await require('./dualChannelLifecycle.service').assertDualProvenanceUnchanged(db,lockedScope);
 const who=actorName(actor);if(decision!=='confirmed'||!String(note||'').trim())throw fail('identity_confirmation_required');
 const bundle=await loadBundle(db,orderSubmissionId,{lock:true});const {parent,artifacts}=bundle;
 if(parent.deleted_at)throw fail('order_cancelled');
 if(parent.purchase_bundle_hash!==expectedBundleHash)throw fail('bundle_changed');
 for(const channel of ['naver','coupang']){
 const primary=artifacts.filter(a=>a.channel===channel&&a.role==='primary');
 if(primary.length!==1||primary[0].revision!==expectedArtifactRevisions?.[channel])throw fail('artifact_revision_changed');
 }
 const review={...(parent.purchase_identity_review||{}),decision,evidenceHash:identityEvidenceHash(bundle),actor:who,confirmedAt:new Date().toISOString(),note:String(note).trim()};
 await db.query('UPDATE order_submissions SET purchase_identity_review=$2 WHERE id=$1',[parent.id,JSON.stringify(review)]);
 return review;
}
async function amendBundlePurchaseAmountInTx({db,orderSubmissionId,channel,paidAmount,expectedRevision,actor,lockedScope}){
 if(lockedScope)await require('./dualChannelLifecycle.service').assertDualProvenanceUnchanged(db,lockedScope);
 const who=actorName(actor);
 if(!['naver','coupang'].includes(channel)||!Number.isInteger(paidAmount)||paidAmount<0||paidAmount>2147483647)throw fail('individual_purchase_amount_required');
 const bundle=await loadBundle(db,orderSubmissionId,{lock:true});const {parent,channels}=bundle;
 if(parent.deleted_at)throw fail('order_cancelled');
 if(parent.purchase_bundle_revision!==expectedRevision)throw fail('bundle_revision_changed');
 if(channels.length!==2||!['naver','coupang'].every(c=>channels.filter(r=>r.channel===c).length===1))throw fail('purchase_channels_incomplete');
 if((await db.query(`SELECT id FROM payment_batch_items WHERE order_submission_id=$1 AND status IN ('pending','paid')`,[parent.id])).rows.length)throw fail('already_locked');
 const original=channels.find(c=>c.channel===channel);const total=channels.reduce((n,c)=>n+(c.channel===channel?paidAmount:c.paid_amount),0);
 if(!Number.isSafeInteger(total)||total>2147483647)throw fail('purchase_total_invalid');
 const seats=(await db.query('SELECT * FROM campaign_participants WHERE order_submission_id=$1 AND active=TRUE AND deleted_at IS NULL FOR UPDATE',[parent.id])).rows;
 if(seats.length!==1)throw fail('order_target_changed');
 const audit={channel,previousAmount:original.paid_amount,paidAmount,actor:who,at:new Date().toISOString(),revision:expectedRevision+1};
 const identityReview={...(parent.purchase_identity_review||{}),amountAmendments:[...(parent.purchase_identity_review?.amountAmendments||[]),audit]};
 await db.query('UPDATE order_purchase_channels SET paid_amount=$3 WHERE order_submission_id=$1 AND channel=$2',[parent.id,channel,paidAmount]);
 const updated=await db.query('UPDATE order_submissions SET price=$2,purchase_bundle_revision=purchase_bundle_revision+1,purchase_identity_review=$4 WHERE id=$1 AND purchase_bundle_revision=$3 RETURNING id',[parent.id,total,expectedRevision,JSON.stringify(identityReview)]);
 if(updated.rows.length!==1)throw fail('bundle_revision_changed');
 const values={'결제금액':String(total),'네이버 금액':String(channel==='naver'?paidAmount:channels.find(c=>c.channel==='naver').paid_amount),'쿠팡 금액':String(channel==='coupang'?paidAmount:channels.find(c=>c.channel==='coupang').paid_amount)};
 // Retire both overlay layers; otherwise the board and financial resolver still see the old total.
 await db.query(`UPDATE participant_edits SET reverted_at=NOW(),reverted_by=$6
   WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL AND field=ANY($3::text[])
   AND ((anchor_type='order' AND anchor_value=$4) OR (anchor_type='manual' AND anchor_value=$5))`,
 [seats[0].sheet_id,seats[0].tab_name,Object.keys(values).map(k=>'col:'+k),String(parent.id),String(seats[0].id),who]);
 await db.query(`UPDATE campaign_participants SET row_json=COALESCE(row_json,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[seats[0].id,JSON.stringify(values)]);
 await db.query(`UPDATE raw_sheet_rows rr SET cells=(SELECT jsonb_agg(CASE WHEN $4::jsonb ? h.label THEN $4::jsonb->h.label ELSE COALESCE(rr.cells->(h.ord::int-1),'""'::jsonb) END ORDER BY h.ord)
   FROM jsonb_array_elements_text(COALESCE(rt.detected_headers,rt.headers)) WITH ORDINALITY AS h(label,ord))
   FROM raw_sheet_tabs rt WHERE rr.sheet_id=$1 AND rr.tab_name=$2 AND rr.row_index=$3
   AND rt.sheet_id=rr.sheet_id AND rt.tab_gid=rr.tab_gid`,[seats[0].sheet_id,seats[0].tab_name,seats[0].seq,JSON.stringify(values)]);
 await db.query(`UPDATE review_index SET row_json=COALESCE(row_json,'{}'::jsonb)||$4::jsonb WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3`,[seats[0].sheet_id,seats[0].tab_name,seats[0].seq,JSON.stringify(values)]);
 return {orderSubmissionId:parent.id,price:total,revision:expectedRevision+1,audit};
}
async function withLifecycle(input,fn){
 const lifecycle=require('./dualChannelLifecycle.service');
 return lifecycle.withDualLifecycleInTx({db:input.db,targets:[{orderSubmissionId:input.orderSubmissionId}],run:async(client,scope)=>{
 await lifecycle.assertDualProvenanceUnchanged(client,scope);
 return fn({...input,db:client,lockedScope:scope});
 }});
}
const resolveBundleIdentityReview=input=>withLifecycle(input,resolveBundleIdentityReviewInTx);
const amendBundlePurchaseAmount=input=>withLifecycle(input,amendBundlePurchaseAmountInTx);
module.exports={resolveBundleIdentityReview,amendBundlePurchaseAmount,resolveBundleIdentityReviewInTx,amendBundlePurchaseAmountInTx};
