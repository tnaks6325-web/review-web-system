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
 // An automatic match counts only while the card/identity/recipient/photo evidence is the one it was computed from.
 const identityReview=parent.purchase_identity_review||{};
 const autoMatch=parent.purchase_identity_result==='match' && identityReview.submittedEvidenceHash===identityHash;
 const staffConfirmed=identityReview.decision==='confirmed' && identityReview.evidenceHash===identityHash;
 if(!autoMatch && !staffConfirmed)reasons.push('identity_staff_pending');
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
/** 결정 349 ④ — 동시진행 작업표의 줄인데 묶음 주문(purchase_bundle_version=1)이 아니면 보통 주문으로 지급하지 않는다.
 *  결정 344 차단 전에 외부모집 수동제출로 들어간 보통 주문(한쪽 금액·캡처 1장)이 일반 지급 경로로 나가는 길을 막는다.
 *  판정 = 공용 발견기 discoverDualScope(작업표 좌표) + 묶음 줄 = bundleTargetsForRows(사본 금지).
 *  ★ 판정 실패는 막는다(fail-closed · 'dual_bundle_check_failed') — 돈이 나가는 경로다.
 *  @returns Map<sheetId\0tabName\0rowIndex, reason> — 보류할 줄만 담는다(일반 작업표·묶음 줄은 없음). */
async function dualBundleIncompleteRows(db,rows=[]){
 const out=new Map(),byTab=new Map();
 for(const r of rows){
  if(!r||!r.sheetId||!r.tabName)continue;
  const k=String(r.sheetId)+'\u0000'+String(r.tabName);
  if(!byTab.has(k))byTab.set(k,{sheetId:String(r.sheetId),tabName:String(r.tabName),tabGid:String(r.tabGid||''),rows:[]});
  byTab.get(k).rows.push(r);
 }
 const lifecycle=require('./dualChannelLifecycle.service'),review=require('./dualChannelReview.service');
 for(const t of byTab.values()){
  let reason=null,bundles=new Map();
  try{
   const scope=await lifecycle.discoverDualScope(db,[{sheetId:t.sheetId,tabName:t.tabName,tabGid:t.tabGid}]);
   if(!scope.campaignIds.length)continue;
   bundles=await review.bundleTargetsForRows(db,t.rows.map(r=>({sheetId:t.sheetId,tabName:t.tabName,rowIndex:Number(r.rowIndex)})));
  }catch(_){reason='dual_bundle_check_failed';}
  for(const r of t.rows){
   const key=[t.sheetId,t.tabName,Number(r.rowIndex)].join('\u0000');
   if(reason||!bundles.has(key))out.set(key,reason||'dual_bundle_incomplete');
  }
 }
 return out;
}
module.exports={evaluateOrderPayoutEligibility,checkBatchDualEligibility,dualBundleIncompleteRows};
