'use strict';
const {evaluateBundleReviewCompletion,identityEvidenceHash,digest}=require('./dualChannelReview.service');
/** financialContext is a server-owned adapter to existing account/mode/fee rules, never HTTP input. */
async function evaluateOrderPayoutEligibility(db,{target,lockedContext,financialContext}={}){
 const state=await evaluateBundleReviewCompletion(db,{orderSubmissionId:target.orderSubmissionId,lockedContext});
 const {parent,channels,artifacts}=state.bundle;
 const reasons=[...state.reasons];
 if(!require('./dualChannelRuntime.service').isDualChannelReady('payment'))reasons.push('dual_channel_not_ready');
 if(channels.length!==2 || !['coupang','naver'].every(c=>channels.filter(r=>r.channel===c).length===1) || channels.some(c=>!Number.isInteger(c.paid_amount)||c.paid_amount<0))reasons.push('purchase_channels_incomplete');
 const sum=channels.reduce((n,c)=>n+c.paid_amount,0);
 if(sum!==Number(parent.price))reasons.push('purchase_total_mismatch');
 if(!['naver','coupang'].every(c=>artifacts.filter(a=>a.channel===c&&a.role==='primary').length===1))reasons.push('purchase_artifacts_incomplete');
 const identityHash=identityEvidenceHash(state.bundle);
 if(parent.purchase_identity_result!=='match' && !(parent.purchase_identity_review?.decision==='confirmed' && parent.purchase_identity_review?.evidenceHash===identityHash))reasons.push('identity_staff_pending');
 for(const slot of state.slots.filter(s=>s.role==='receipt')){
 const receipts=state.current.filter(r=>r.purchase_channel===slot.channel&&r.evidence_role==='receipt');
 if(!receipts.some(r=>(r.inspection_status==='pass'&&r.checks?.receiptValidation?.verdict==='pass')||(r.inspection_status==='resolved'&&r.resolution==='ok'&&r.checks?.receiptValidation)))reasons.push('missing_validated_'+slot.channel+'_receipt');
 }
 const seat=(await db.query(`SELECT * FROM campaign_participants WHERE order_submission_id=$1 AND active=TRUE AND deleted_at IS NULL`+(lockedContext && lockedContext.lock!==false?' FOR UPDATE':''),[parent.id])).rows;
 if(seat.length!==1 || seat[0].sheet_id!==target.sheetId || seat[0].tab_name!==target.tabName || seat[0].seq!==Number(target.rowIndex))reasons.push('order_target_changed');
 const amount=seat[0]?.row_json?.['결제금액'];
 if(amount==null || !/^\d+$/.test(String(amount).replace(/,/g,'')) || Number(String(amount).replace(/,/g,''))!==sum)reasons.push('workboard_total_mismatch');
 const active=(await db.query(`SELECT id FROM payment_batch_items WHERE order_submission_id=$1 AND status IN ('pending','paid')`,[parent.id])).rows;
 if(active.some(x=>String(x.id)!==String(lockedContext?.paymentItemId||'')))reasons.push('already_locked');
 let financial=null;
 const resolveFinancial=financialContext||require('./payment.service').resolveDualFinancialContext;
 if(typeof resolveFinancial==='function')financial=await resolveFinancial(db,target,{lockedContext});
 if(!financial || !financial.bankName || !financial.bankAccount || !financial.accountHolder || !Number.isInteger(financial.reviewFee) || financial.reviewFee<0 || !['ours','split'].includes(financial.payoutMode))reasons.push('financial_context_unverified');
 if(financial && financial.productPrice!==sum)reasons.push('financial_amount_changed');
 if(financial?.reasons?.length)reasons.push(...financial.reasons);
 const productPrice=financial?.payoutMode==='split'?0:sum;
 const reviewFee=financial?.reviewFee??null;
 const fingerprint=digest({id:parent.id,revision:parent.purchase_bundle_revision,identityHash,price:sum,financial,current:state.current.map(r=>[r.file_id,r.byte_sha256,r.evidence_revision,r.inspection_status,r.resolution,r.checks])});
 return {eligible:!reasons.length,reasons,productPrice,reviewFee,fingerprint,orderSubmissionId:parent.id};
}

async function checkBatchDualEligibility({items=[]}={}, {db,lockedScope,lock=false,financialContext}={}){
 const dual=items.filter(i=>i.order_submission_id&&i.status!=='cancelled');const blocked=[];
 if(lock && dual.length)await require('./dualChannelLifecycle.service').assertDualProvenanceUnchanged(db,lockedScope);
 for(const item of dual){
  const result=await evaluateOrderPayoutEligibility(db,{target:{orderSubmissionId:item.order_submission_id,sheetId:item.sheet_id,tabName:item.tab_name,rowIndex:item.row_index},lockedContext:{paymentItemId:item.id,lock},financialContext});
  if(!result.eligible||result.fingerprint!==item.eligibility_fingerprint||result.productPrice!==item.product_price||result.reviewFee!==item.review_fee)
   blocked.push({itemId:item.id,reasons:[...result.reasons,...(result.fingerprint!==item.eligibility_fingerprint?['eligibility_changed']:[])]});
 }
 return {ok:!blocked.length,blocked};
}
module.exports={evaluateOrderPayoutEligibility,checkBatchDualEligibility};
