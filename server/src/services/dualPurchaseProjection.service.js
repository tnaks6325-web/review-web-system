'use strict';
const {fail}=require('./dualPurchaseProof.service');
// One SQL/validation shared by the single (writer/recovery) and batched (workdesk) loaders.
const PROJECTION_SQL=`SELECT os.*,
  (SELECT jsonb_agg(c ORDER BY c.channel) FROM order_purchase_channels c WHERE c.order_submission_id=os.id) AS bundle_channels,
  (SELECT jsonb_agg(a ORDER BY a.channel,a.role) FROM purchase_capture_artifacts a WHERE a.order_submission_id=os.id AND a.status='committed' AND a.superseded_at IS NULL) AS bundle_artifacts
  FROM order_submissions os`;
function validatedProjection(parent){
 const channels=parent.bundle_channels || [], currentArtifacts=parent.bundle_artifacts || [];
 if(parent.purchase_bundle_version!==1 || channels.length!==2 || !['naver','coupang'].every(k=>channels.some(c=>c.channel===k)&&currentArtifacts.some(a=>a.channel===k&&a.role==='primary'))
  || Number(parent.price)!==channels.reduce((s,c)=>s+c.paid_amount,0))fail('DUAL_PROJECTION_INCOMPLETE');
 delete parent.bundle_channels;delete parent.bundle_artifacts;return {parent,channels,currentArtifacts};
}
async function loadCommittedOrderForProjection(db,orderId){
 const rows=(await db.query(PROJECTION_SQL+' WHERE os.id=$1',[orderId])).rows;
 const parent=rows[0];if(!parent)fail('DUAL_ORDER_MISSING');
 return validatedProjection(parent);
}
/** Batched form of the loader above. Map value = projection, or the per-order Error (never a partial projection). */
async function loadCommittedOrdersForProjection(db,orderIds){
 const ids=[...new Set((orderIds||[]).filter(Boolean).map(String))].sort();
 const out=new Map();if(!ids.length)return out;
 const rows=(await db.query(PROJECTION_SQL+' WHERE os.id=ANY($1::uuid[])',[ids])).rows;
 for(const id of ids){
  const parent=rows.find(r=>String(r.id)===id);
  try{if(!parent)fail('DUAL_ORDER_MISSING');out.set(id,validatedProjection(parent));}catch(e){out.set(id,e);}
 }
 return out;
}
function bundleWorkboardProjection({parent,channels,currentArtifacts}){
 if(channels.length!==2 || !currentArtifacts.length)fail('DUAL_PROJECTION_INCOMPLETE');
 const data=require('./orderLedger.service')._osRowToOrderData(parent);
 return {...data,price:String(channels.reduce((s,c)=>s+c.paid_amount,0)),dualPurchases:Object.fromEntries(channels.map(c=>[c.channel,{orderNum:c.order_num,userId:c.user_id,paidAmount:c.paid_amount}]))};
}
/** Internal-staff workdesk row contract. Unknown/incomplete sub-records keep only the parent id (screen: 확인 필요). */
function workdeskDualPurchase(orderSubmissionId,loaded){
 if(!loaded || loaded instanceof Error)return {orderSubmissionId:String(orderSubmissionId)};
 const {parent,channels,currentArtifacts}=loaded;
 return {orderSubmissionId:parent.id,revision:parent.purchase_bundle_revision,bundleHash:parent.purchase_bundle_hash,
  identityResult:parent.purchase_identity_result,identityReview:parent.purchase_identity_review ?? null,
  purchases:Object.fromEntries(channels.map(c=>[c.channel,{paidAmount:c.paid_amount}])),
  artifacts:currentArtifacts.map(a=>({id:a.id,channel:a.channel,role:a.role,revision:a.revision,fileId:a.file_id}))};
}
/**
 * Reviewer purchase-form reopen state = CAS references only. Never approval/identity tokens, hashes, file ids,
 * extraction results or typed values (the screen re-approves). The caller must already have proven ownership of
 * THIS application (work-detail: campaign + phone8 + hold_token exact match). Closed/unknown -> null, and the
 * screen then refuses to stage instead of guessing.
 */
async function reviewerPurchaseDraft(db,{campaignId,applicationId}){
 if(!require('./dualChannelRuntime.service').isDualChannelReady('purchase'))return null;
 const proof=require('./dualPurchaseProof.service');
 const app=(await db.query(`SELECT a.id,to_jsonb(a) AS raw,rc.work_detail,to_jsonb(rc)->'cash_receipt_required' AS cash_receipt_required
   FROM campaign_applications a JOIN recruit_campaigns rc ON rc.id=a.campaign_id WHERE a.id=$1 AND a.campaign_id=$2`,[applicationId,campaignId])).rows[0];
 const product=app?.work_detail?.dualChannelProduct;
 if(!product?.channels?.naver || !product?.channels?.coupang)return null;
 const owner=app.raw.owner_reviewer_id ?? null;
 const artifacts=(await db.query(`SELECT id,channel,role,revision,created_by FROM purchase_capture_artifacts
   WHERE application_id=$1 AND status='staged' AND superseded_at IS NULL ORDER BY channel,role`,[app.id])).rows;
 // A staged row written by anyone but this application's owner is never handed to the hold-token holder.
 if(artifacts.some(a=>!owner || String(a.created_by)!==String(owner)))return null;
 const committed=(await db.query('SELECT id FROM order_submissions WHERE purchase_bundle_application_id=$1',[app.id])).rows[0];
 return {version:1,campaignApplicationId:app.id,
  // Opaque change detectors only; they are not compared with stored artifact hashes.
  conditionFingerprint:proof.hash({product,cashReceiptRequired:app.cash_receipt_required===true}),
  identityFingerprint:proof.hash({application:app.id,owner,identity:app.raw.participant_identity_id ?? null,card:app.raw.participant_card_id ?? null,phone8:app.raw.owner_phone8 ?? app.raw.phone8 ?? null}),
  artifacts:artifacts.map(a=>({id:a.id,channel:a.channel,role:a.role,revision:a.revision})),
  committedOrderSubmissionId:committed?committed.id:null};
}
module.exports={loadCommittedOrderForProjection,loadCommittedOrdersForProjection,bundleWorkboardProjection,workdeskDualPurchase,reviewerPurchaseDraft};
