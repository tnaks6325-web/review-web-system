'use strict';
const {randomUUID}=require('crypto');const proof=require('./dualPurchaseProof.service');
function createService(deps={}){
 const db=deps.db||require('../db/pool');
 const drive=deps.drive||{upload:async(b,mime,folder)=>(await require('./drive.service').uploadFileBase64(b.toString('base64'),'dual-replace-'+randomUUID(),mime,folder)).id,read:async id=>(await require('./drive.service').downloadFile(id)).buffer};
 const runtime=()=>deps.runtime||require('./dualChannelRuntime.service');const lifecycle=()=>deps.lifecycle||require('./dualChannelLifecycle.service');
 async function folder(parent){
  if(deps.resolveFolder)return deps.resolveFolder(parent);
  const rootFolderId=process.env.AI_REVIEW_FOLDER_ID||process.env.DRIVE_ROOT_FOLDER_ID;if(!rootFolderId)proof.fail('DUAL_DRIVE_NOT_CONFIGURED');
  return (await require('./captureFolder.service').resolveCaptureFolder({sheetId:parent.sheet_id,tabName:parent.tab_name,rootFolderId})).folderId;
 }
 // Caller supplies the authenticated internal actor after the existing work-permission gate.
 // Scope is rediscovered from the order; HTTP prelocked/folder/parent data is never used.
 async function replacePurchaseArtifact(args){
  runtime().assertDualChannelReady('review');
  const {orderSubmissionId,channel,role='primary',expectedArtifactId,expectedRevision,sourceArtifactId,actor}=args;
  if(!actor||!['naver','coupang'].includes(channel)||!['primary','supplement'].includes(role)||!Number.isSafeInteger(expectedRevision))proof.fail('DUAL_REPLACE_INVALID');
  const tx=run=>lifecycle().withDualLifecycleInTx({db,targets:[{orderSubmissionId}],run});
  const inspect=async c=>{
   const parent=(await c.query('SELECT * FROM order_submissions WHERE id=$1 FOR UPDATE',[orderSubmissionId])).rows[0];
   if(!parent||parent.purchase_bundle_version!==1||parent.deleted_at||parent.mirror_status==='canceled')proof.fail('DUAL_ORDER_MISSING');
   if((await c.query("SELECT id FROM payment_batch_items WHERE order_submission_id=$1 AND status IN ('pending','paid')",[parent.id])).rows.length)proof.fail('DUAL_PAYMENT_LOCKED');
   const current=(await c.query("SELECT * FROM purchase_capture_artifacts WHERE order_submission_id=$1 AND channel=$2 AND role=$3 AND status='committed' AND superseded_at IS NULL FOR UPDATE",[parent.id,channel,role])).rows[0];
   if(!current||current.id!==expectedArtifactId||current.revision!==expectedRevision)proof.fail('DUAL_ARTIFACT_CHANGED');
   let source;
   if(sourceArtifactId){source=(await c.query('SELECT * FROM purchase_capture_artifacts WHERE id=$1',[sourceArtifactId])).rows[0];
    if(!source||source.application_id!==current.application_id||source.order_submission_id!==parent.id||source.channel!==channel||source.role!==role)proof.fail('DUAL_RESTORE_INVALID');}
   return {parent,current,source,fingerprint:proof.hash({revision:parent.purchase_bundle_revision,snapshot:parent.purchase_condition_snapshot,current})};
  };
  const prepared=await tx(inspect);
  let fileId,sha;
  if(prepared.source){fileId=prepared.source.file_id;sha=proof.sha(await drive.read(fileId));if(sha!==prepared.source.byte_sha256)proof.fail('DUAL_FILE_BYTES_CHANGED');}
  else {
   if(!/^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/.test(args.mimeType||''))proof.fail('DUAL_IMAGE_INVALID');
   const bytes=proof.bytes(args.imageBase64);sha=proof.sha(bytes);
   fileId=await drive.upload(bytes,args.mimeType,await folder(prepared.parent));
   if(!fileId||proof.sha(await drive.read(fileId))!==sha)proof.fail('DUAL_FILE_BYTES_CHANGED');
  }
  // Intentionally preserve all files on exceptions, including ambiguous COMMIT responses.
  return tx(async c=>{
   const p=await inspect(c);if(p.fingerprint!==prepared.fingerprint)proof.fail('DUAL_ARTIFACT_CHANGED');
   const shaGuard=require('../utils/dualEvidenceShaLock');
   await shaGuard.lockEvidenceShaInTx(c,sha);
   if((await shaGuard.evidenceShaUsesInTx(c,sha)).some(u=>u.kind==='review'))proof.fail('DUAL_IMAGE_REUSED');
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['dual-artifact:file:'+fileId]);
   const history=(await c.query('SELECT * FROM purchase_capture_artifacts WHERE byte_sha256=$1 OR file_id=$2 ORDER BY id FOR UPDATE',[sha,fileId])).rows;
   if(history.some(a=>a.application_id!==p.current.application_id||a.channel!==channel||a.role!==role))proof.fail('DUAL_IMAGE_REUSED');
   await c.query("UPDATE purchase_capture_artifacts SET superseded_at=now(),status='superseded' WHERE id=$1",[p.current.id]);
   const revision=p.current.revision+1;
   const row=(await c.query(`INSERT INTO purchase_capture_artifacts(id,application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,extraction_json,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'committed',$13) RETURNING *`,[randomUUID(),p.current.application_id,p.parent.id,channel,role,revision,fileId,sha,{staffReplacement:true,sourceArtifactId:sourceArtifactId||null,previousArtifactId:p.current.id,actor:String(actor),extracted:prepared.source?.extraction_json?.extracted||{},identityInvalidated:true},proof.hash({fileId,sha,actor:String(actor),revision}),p.current.final_input_hash,proof.hash(p.parent.purchase_condition_snapshot),String(actor)])).rows[0];
   const historyReview=Array.isArray(p.parent.purchase_identity_review?.history)?p.parent.purchase_identity_review.history:[];
   await c.query(`UPDATE order_submissions SET purchase_bundle_revision=purchase_bundle_revision+1,purchase_identity_result='uncertain',purchase_identity_review=$2,updated_at=now() WHERE id=$1`,[p.parent.id,{status:'pending',reason:'purchase_artifact_changed',history:[...historyReview,{actor:String(actor),previousArtifactId:p.current.id,artifactId:row.id,revision,restoredFrom:sourceArtifactId||null}]}]);
   return row;
  });
 }
 return {replacePurchaseArtifact,stagePurchaseArtifact:args=>require('./dualPurchaseSubmission.service').createService(deps).stagePurchaseArtifact(args)};
}
let production;const get=()=>production||(production=createService());
module.exports={createService,stagePurchaseArtifact:args=>require('./dualPurchaseSubmission.service').stagePurchaseArtifact(args),replacePurchaseArtifact:args=>get().replacePurchaseArtifact(args)};
