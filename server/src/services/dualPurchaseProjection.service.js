'use strict';
const {fail}=require('./dualPurchaseProof.service');
async function loadCommittedOrderForProjection(db,orderId){
 const rows=(await db.query(`SELECT os.*,
  (SELECT jsonb_agg(c ORDER BY c.channel) FROM order_purchase_channels c WHERE c.order_submission_id=os.id) AS bundle_channels,
  (SELECT jsonb_agg(a ORDER BY a.channel,a.role) FROM purchase_capture_artifacts a WHERE a.order_submission_id=os.id AND a.status='committed' AND a.superseded_at IS NULL) AS bundle_artifacts
  FROM order_submissions os WHERE os.id=$1`,[orderId])).rows;
 const parent=rows[0];if(!parent)fail('DUAL_ORDER_MISSING');
 const channels=parent.bundle_channels || [], currentArtifacts=parent.bundle_artifacts || [];
 if(parent.purchase_bundle_version!==1 || channels.length!==2 || !['naver','coupang'].every(k=>channels.some(c=>c.channel===k)&&currentArtifacts.some(a=>a.channel===k&&a.role==='primary'))
  || Number(parent.price)!==channels.reduce((s,c)=>s+c.paid_amount,0))fail('DUAL_PROJECTION_INCOMPLETE');
 delete parent.bundle_channels;delete parent.bundle_artifacts;return {parent,channels,currentArtifacts};
}
function bundleWorkboardProjection({parent,channels,currentArtifacts}){
 if(channels.length!==2 || !currentArtifacts.length)fail('DUAL_PROJECTION_INCOMPLETE');
 const data=require('./orderLedger.service')._osRowToOrderData(parent);
 return {...data,price:String(channels.reduce((s,c)=>s+c.paid_amount,0)),dualPurchases:Object.fromEntries(channels.map(c=>[c.channel,{orderNum:c.order_num,userId:c.user_id,paidAmount:c.paid_amount}]))};
}
module.exports={loadCommittedOrderForProjection,bundleWorkboardProjection};
