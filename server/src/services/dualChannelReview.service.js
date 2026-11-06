'use strict';
const crypto=require('node:crypto');
const mutationStorage=new (require('node:async_hooks').AsyncLocalStorage)();
const proof=()=>require('./dualPurchaseProof.service');
const {snapshotCaptureSlots,resolveSnapshotSlot}=require('../utils/captureSlots');
// Purchase and review must hash the exact same canonical snapshot, including JSONB key order.
const digest=value=>proof().hash(value);
const fail=code=>Object.assign(new Error(code),{code,status:409});
async function loadBundle(db,orderSubmissionId,{lock=false}={}){
 const parent=(await db.query('SELECT * FROM order_submissions WHERE id=$1'+(lock?' FOR UPDATE':''),[orderSubmissionId])).rows[0];
 if(!parent || parent.purchase_bundle_version!==1)throw fail('dual_order_required');
 const channels=(await db.query('SELECT * FROM order_purchase_channels WHERE order_submission_id=$1 ORDER BY channel'+(lock?' FOR UPDATE':''),[parent.id])).rows;
 const artifacts=(await db.query(`SELECT * FROM purchase_capture_artifacts WHERE order_submission_id=$1 AND status='committed' AND superseded_at IS NULL ORDER BY channel,role`+(lock?' FOR UPDATE':''),[parent.id])).rows;
 return {parent,channels,artifacts};
}
function identityEvidenceHash({parent,channels,artifacts}){
 return digest({bundleHash:parent.purchase_bundle_hash,owner:parent.owner_reviewer_id,card:parent.participant_card_id,identity:parent.participant_identity_key_hash,channels:channels.map(c=>[c.channel,c.recipient,c.phone,c.address]),artifacts:artifacts.map(a=>[a.channel,a.role,a.id,a.revision,a.file_id,a.byte_sha256])});
}
async function evaluateBundleReviewCompletion(db,{orderSubmissionId,lockedContext}={}){
 const locking=!!lockedContext && lockedContext.lock!==false;
 const bundle=await loadBundle(db,orderSubmissionId,{lock:locking});
 if(locking){
  const files=(await db.query('SELECT file_id FROM review_submissions WHERE order_submission_id=$1 ORDER BY id FOR UPDATE',[bundle.parent.id])).rows.map(r=>r.file_id);
  if(files.length)await db.query('SELECT file_id FROM review_inspections WHERE file_id=ANY($1::text[]) ORDER BY file_id FOR UPDATE',[files]);
 }
 const {parent}=bundle;
 const slots=snapshotCaptureSlots(parent.purchase_condition_snapshot);
 const rows=(await db.query(`SELECT rs.*,ri.status AS inspection_status,ri.resolution,ri.checks FROM review_submissions rs LEFT JOIN review_inspections ri ON ri.file_id=rs.file_id WHERE rs.order_submission_id=$1 ORDER BY rs.evidence_revision,rs.id`,[parent.id])).rows;
 const reasons=[]; const current=[]; const revisions={};
 const expectedHash=digest(parent.purchase_condition_snapshot);
 for(const slot of slots){
 const same=rows.filter(r=>r.purchase_channel===slot.channel && r.evidence_role===slot.role);
 const revision=Math.max(0,...same.map(r=>Number(r.evidence_revision)||0));
 revisions[slot.key]=revision; // same rule as recordReviewUploadInTx expectedRevision
 const valid=same.filter(r=>!r.superseded_at && r.slot_key===slot.key && Number(r.evidence_revision)===revision && revision>0 && r.completed_at && String(r.file_id||'').trim() && /^[a-f0-9]{64}$/.test(r.byte_sha256||'') && r.condition_snapshot_hash===expectedHash);
 if(!valid.length){if(slot.role==='review')reasons.push('missing_'+slot.channel+'_review');continue;}
 current.push(...valid);
 }
 const files=new Set(),hashes=new Set();
 for(const r of current){
 if(files.has(r.file_id)||hashes.has(r.byte_sha256))reasons.push('duplicate_evidence');
 files.add(r.file_id);hashes.add(r.byte_sha256);
 }
 if(parent.deleted_at)reasons.push('order_cancelled');
 return {complete:!reasons.length,reasons,current,bundle,slots,revisions};
}
async function inspectionContextForOrder(db,{orderSubmissionId,slotKey}){
 const {parent}=await loadBundle(db,orderSubmissionId);
 const slot=resolveSnapshotSlot(parent.purchase_condition_snapshot,slotKey);
 if(!slot)throw fail('dual_slot_invalid');
 return {conditionSnapshot:parent.purchase_condition_snapshot,slotRole:slot.role,expectedChannel:slot.channel,orderSubmissionId:parent.id};
}

/** Resolve native parent from current workboard affinity; never trust a request's bundle marker. */
async function bundleTargetForRow(db,target){
 const {rows}=await db.query(`SELECT os.id FROM campaign_participants cp JOIN order_submissions os ON os.id=cp.order_submission_id
   WHERE cp.sheet_id=$1 AND cp.tab_name=$2 AND cp.seq=$3 AND cp.active=TRUE AND cp.deleted_at IS NULL
   AND (to_jsonb(os)->>'purchase_bundle_version')='1'`,[target.sheetId,target.tabName,Number(target.rowIndex)]);
 if(rows.length>1)throw fail('order_target_ambiguous');
 if(!rows.length)return null;
 if(target.orderSubmissionId && String(rows[0].id).toLowerCase()!==String(target.orderSubmissionId).toLowerCase())throw fail('order_target_changed');
 return {...target,orderSubmissionId:rows[0].id};
}

async function bundleTargetsForRows(db,targets){
 if(!targets.length)return new Map();
 const {rows}=await db.query(`WITH wanted AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("sheetId" text,"tabName" text,"rowIndex" integer))
  SELECT os.id,to_jsonb(os) AS parent,w."sheetId",w."tabName",w."rowIndex" FROM wanted w JOIN campaign_participants cp ON cp.sheet_id=w."sheetId" AND cp.tab_name=w."tabName" AND cp.seq=w."rowIndex"
  JOIN order_submissions os ON os.id=cp.order_submission_id WHERE cp.active=TRUE AND cp.deleted_at IS NULL AND to_jsonb(os)->>'purchase_bundle_version'='1'`,[JSON.stringify(targets.map(t=>({sheetId:t.sheetId,tabName:t.tabName,rowIndex:Number(t.rowIndex??t.rowNum)})))]);
 const out=new Map();for(const row of rows){const k=[row.sheetId,row.tabName,Number(row.rowIndex)].join('\u0000');if(out.has(k))throw fail('order_target_ambiguous');out.set(k,{sheetId:row.sheetId,tabName:row.tabName,rowIndex:Number(row.rowIndex),orderSubmissionId:row.id,parent:row.parent});}return out;
}

async function recomputeBundleReviewStateInTx(db,orderSubmissionId){
 const state=await evaluateBundleReviewCompletion(db,{orderSubmissionId});
 const seats=(await db.query('SELECT * FROM campaign_participants WHERE order_submission_id=$1 AND active=TRUE AND deleted_at IS NULL',[orderSubmissionId])).rows;
 if(seats.length!==1)throw fail('order_target_changed');const seat=seats[0];
 await db.query(`UPDATE campaign_participants SET is_submitted=$2 WHERE id=$1`,[seat.id,state.complete]);
 // Sheetless boards rebuild review_index.is_submitted from the worktable status cell; write it on the
 // incomplete->complete transition in this transaction, like the legacy web completion (submit.routes).
 if(state.complete && seat.is_submitted!==true){
  const st=await require('./sheetlessStatus.service').markStatusCell({sheetId:seat.sheet_id,tabName:seat.tab_name,rowIndex:seat.seq,kind:'submit',by:'dual-review-complete',client:db});
  if(st && st.handled && !st.ok)throw Object.assign(new Error(st.reason||'write_failed'),{code:'review_board_write_failed',status:409});
 }
 const primary=state.current.find(r=>r.evidence_role==='review');
 await db.query(`UPDATE review_index SET is_submitted=$4,review_file_id=$5,review_file_url=$6,review_file_name=$7,review_file_count=$8
  WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3`,[seat.sheet_id,seat.tab_name,seat.seq,state.complete,primary?.file_id||null,primary?.file_url||null,primary?.file_name||null,state.current.filter(r=>r.evidence_role==='review').length]);
 // Same participation-token binding as the legacy web completion (submit.routes): payment targets exclude
 // rows whose active obligation is still pending, so a finished bundle must settle it here. Only web-fulfilled
 // obligations return to pending when evidence is later removed; closed_no_review is never touched.
 if(state.complete)await db.query(`UPDATE reviewer_participations p SET review_obligation_status='fulfilled',
   review_evidence=p.review_evidence||jsonb_build_object('web_submission',cp.review_participation_id),record_version=p.record_version+1,updated_at=now()
  FROM campaign_participants cp WHERE cp.id=$1 AND cp.active=TRUE AND cp.deleted_at IS NULL AND cp.is_submitted=TRUE
   AND p.campaign_participant_id=cp.id AND p.lifecycle_status='active' AND p.index_snapshot->>'_review_participation_id'=cp.review_participation_id::text
   AND p.review_obligation_status NOT IN ('fulfilled','closed_no_review')`,[seat.id]);
 else await db.query(`UPDATE reviewer_participations p SET review_obligation_status='pending',record_version=p.record_version+1,updated_at=now()
  FROM campaign_participants cp WHERE cp.id=$1 AND p.campaign_participant_id=cp.id AND p.lifecycle_status='active'
   AND p.review_obligation_status='fulfilled' AND p.review_evidence->>'web_submission'=cp.review_participation_id::text`,[seat.id]);
 return state;
}

async function fileMutationContext(db,fileIds){
 fileIds=fileIds.filter(f=>typeof f==='string'&&f);
 if(!fileIds.length)return {submissions:[],targets:[],dual:false,fingerprint:'[]'};
 const {rows}=await db.query('SELECT to_jsonb(s) AS submission FROM review_submissions s WHERE s.file_id=ANY($1::text[]) ORDER BY s.file_id',[fileIds]);
 const submissions=rows.map(r=>r.submission).filter(Boolean);
 const targets=[];for(const s of submissions){
  if(s.order_submission_id)targets.push({orderSubmissionId:s.order_submission_id});
  if(s.sheet_id&&s.tab_name)targets.push({sheetId:s.sheet_id,tabName:s.tab_name});
 }
 return {submissions,targets,dual:submissions.some(s=>s.order_submission_id),fingerprint:JSON.stringify(submissions)};
}
/** All participating file scopes are discovered together, before any row/file lock (including the kept duplicate). */
async function withReviewFilesMutation({db,fileIds=[],run}){
 const nested=mutationStorage.getStore();
 if(nested && nested.db===db){if(!fileIds.every(f=>nested.fileIds.has(f)))throw fail('review_scope_incomplete');return run(db,await fileMutationContext(db,fileIds));}
 const before=await fileMutationContext(db,fileIds);
 if(!before.dual)return run(db,before);
 const lifecycle=require('./dualChannelLifecycle.service');
 return lifecycle.withDualLifecycleInTx({db,targets:before.targets,run:async(client,scope)=>{
  const after=await fileMutationContext(client,fileIds);
  if(after.fingerprint!==before.fingerprint)throw fail('review_scope_changed_retry');
  const result=await mutationStorage.run({db:client,fileIds:new Set(fileIds)},()=>run(client,{...after,scope}));
  for(const id of [...new Set(after.submissions.map(s=>s.order_submission_id).filter(Boolean))].sort())await recomputeBundleReviewStateInTx(client,id);
  return result;
 }});
}


async function removeReviewEvidenceInTx({db,lockedScope,fileId,expectedRevision,actor}){
 if(!actor)throw fail('staff_actor_required');
 await require('./dualChannelLifecycle.service').assertDualProvenanceUnchanged(db,lockedScope);
 const row=(await db.query('SELECT * FROM review_submissions WHERE file_id=$1 FOR UPDATE',[fileId])).rows[0];
 if(!row?.order_submission_id||row.superseded_at||row.evidence_revision!==expectedRevision)throw fail('review_revision_changed');
 await db.query('UPDATE review_submissions SET superseded_at=NOW() WHERE file_id=$1',[fileId]);
 return recomputeBundleReviewStateInTx(db,row.order_submission_id);
}
async function removeReviewEvidence(input){
 return withReviewFilesMutation({db:input.db,fileIds:[input.fileId],run:(db,ctx)=>removeReviewEvidenceInTx({...input,db,lockedScope:ctx.scope})});
}
function createService(deps={}){
 const db=deps.db||require('../db/pool');
 const lifecycle=()=>deps.lifecycle||require('./dualChannelLifecycle.service');
 const drive=deps.drive||{
  upload:async(bytes,mime,folder)=>{const r=await require('./drive.service').uploadFileBase64(bytes.toString('base64'),'dual-review-'+crypto.randomUUID(),mime,folder);return r.id;},
  read:async file=>{const r=await require('./drive.service').downloadFile(file);return r.buffer;},
 };
 async function authorize(client,body,reviewerSession,actor,lockedScope){
  const target=await bundleTargetForRow(client,body);if(!target)throw fail('dual_order_required');
  const bundle=await loadBundle(client,target.orderSubmissionId,{lock:true});
  if(bundle.parent.deleted_at)throw fail('order_cancelled');
  if(!deps.authorizeTarget)await require('./reviewCompletionTransaction.service').lockTarget(client,{...target,reviewerSession,lockedScope});
  if(reviewerSession){
   if(!bundle.parent.owner_reviewer_id||bundle.parent.owner_reviewer_id!==reviewerSession.ownerReviewerId)throw fail('review_owner_changed');
   const owns=deps.authorizeTarget||((args)=>require('./reviewerTargetOwnership.service').ownsReviewerTarget(args));
   if(!await owns({session:reviewerSession,...target,client}))throw fail('review_owner_changed');
  }else if(!actor)throw fail('reviewer_auth_required');
  return {target,bundle,owner:bundle.parent.owner_reviewer_id};
 }
 async function withScope(input,run){
  (deps.runtime||require('./dualChannelRuntime.service')).assertDualChannelReady('review');
  return lifecycle().withDualLifecycleInTx({db,targets:[{orderSubmissionId:input.body.orderSubmissionId}],run:async(client,scope)=>run(client,scope)});
 }
 async function recordReviewUploadInTx({client,lockedScope,body,reviewerSession,actor}){
  (deps.runtime||require('./dualChannelRuntime.service')).assertDualChannelReady('review');
  await lifecycle().assertDualProvenanceUnchanged(client,lockedScope);
  const {target,bundle,owner}=await authorize(client,body,reviewerSession,actor,lockedScope);
  const slot=resolveSnapshotSlot(bundle.parent.purchase_condition_snapshot,body.slotKey);if(!slot)throw fail('dual_slot_invalid');
  const bytes=proof().bytes(body.imageBase64);const sha=proof().sha(bytes);
  const mime=body.mimeType||'image/jpeg';if(!/^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/.test(mime))throw fail('review_image_invalid');
  const all=(await client.query(`SELECT * FROM review_submissions WHERE order_submission_id=$1 AND purchase_channel=$2 AND evidence_role=$3 ORDER BY evidence_revision FOR UPDATE`,[target.orderSubmissionId,slot.channel,slot.role])).rows;
  const revision=Math.max(0,...all.map(r=>r.evidence_revision||0));
  if(!Number.isInteger(body.expectedRevision)||revision!==body.expectedRevision)throw fail('review_revision_changed');
  // Hash/file locks are global and sorted; history also prevents cross-order/channel reuse.
  const shaGuard=require('../utils/dualEvidenceShaLock');
  await shaGuard.lockEvidenceShaInTx(client,sha);
  const duplicate=await shaGuard.evidenceShaUsesInTx(client,sha);
  if(duplicate.length)throw fail('duplicate_evidence');
  let folder=deps.folderForSlot?await deps.folderForSlot(client,target,slot):null;
  if(!folder && !deps.drive){
   const cfg=(await client.query('SELECT folder_url FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2',[target.sheetId,target.tabName])).rows[0];
   const svc=require('./drive.service');const root=svc.extractFolderIdFromUrl(cfg?.folder_url||'');if(!root)throw fail('review_folder_missing');
   folder=await svc.getOrCreateSubFolder(root,slot.label);folder=folder.id||folder;
  }
  const fileId=await drive.upload(bytes,mime,folder);
  const actual=await drive.read(fileId);if(!Buffer.isBuffer(actual)||proof().sha(actual)!==sha)throw fail('review_file_changed');
  // Replacing one selected photo retains other photos in the slot at the same new revision.
  if(body.replaceFileId && !all.some(r=>r.file_id===body.replaceFileId&&!r.superseded_at))throw fail('review_revision_changed');
  if(body.replaceFileId)await client.query('UPDATE review_submissions SET superseded_at=NOW() WHERE file_id=$1 AND order_submission_id=$2',[body.replaceFileId,target.orderSubmissionId]);
  await client.query(`UPDATE review_submissions SET evidence_revision=$4 WHERE order_submission_id=$1 AND purchase_channel=$2 AND evidence_role=$3 AND superseded_at IS NULL`,[target.orderSubmissionId,slot.channel,slot.role,revision+1]);
  const snapshotHash=digest(bundle.parent.purchase_condition_snapshot);const uploadBatchId=crypto.randomUUID();
  const {rows}=await client.query(`INSERT INTO review_submissions(sheet_id,tab_name,row_index,reviewer_name,file_id,file_name,file_hash,source,slot_key,upload_batch_id,
   order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash,uploaded_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'upload',$8,$9,$10,$11,$12,$13,$7,$14,NOW()) RETURNING *`,
  [target.sheetId,target.tabName,target.rowIndex,body.reviewerName||'',fileId,'dual-review-'+fileId,sha,slot.key,uploadBatchId,target.orderSubmissionId,slot.channel,slot.role,revision+1,snapshotHash]);
  await recomputeBundleReviewStateInTx(client,target.orderSubmissionId);
  const uploadToken=proof().sign('review-upload',{order:target.orderSubmissionId,owner,fileId,sha,channel:slot.channel,role:slot.role,revision:revision+1,snapshotHash});
  return {fileId,uploadToken,evidence:rows[0],conditionSnapshot:bundle.parent.purchase_condition_snapshot,slotRole:slot.role,expectedChannel:slot.channel};
 }
 async function completeReviewUploadInTx({client,lockedScope,body,reviewerSession,actor}){
  (deps.runtime||require('./dualChannelRuntime.service')).assertDualChannelReady('review');
  await lifecycle().assertDualProvenanceUnchanged(client,lockedScope);
  const {target,bundle,owner}=await authorize(client,body,reviewerSession,actor,lockedScope);
  if(!Array.isArray(body.uploadTokens)||!body.uploadTokens.length)throw fail('review_upload_proof_invalid');
  for(const token of body.uploadTokens){
   let p;try{p=proof().verify(token,'review-upload');}catch(_){throw fail('review_upload_proof_invalid');}
   if(p.order!==target.orderSubmissionId||p.owner!==owner||p.snapshotHash!==digest(bundle.parent.purchase_condition_snapshot))throw fail('review_upload_proof_invalid');
   const row=(await client.query('SELECT * FROM review_submissions WHERE file_id=$1 AND order_submission_id=$2 FOR UPDATE',[p.fileId,p.order])).rows[0];
   if(!row||row.superseded_at||row.purchase_channel!==p.channel||row.evidence_role!==p.role||row.evidence_revision<p.revision||row.byte_sha256!==p.sha||row.condition_snapshot_hash!==p.snapshotHash)throw fail('review_upload_proof_invalid');
   const bytes=await drive.read(p.fileId);if(!Buffer.isBuffer(bytes)||proof().sha(bytes)!==p.sha)throw fail('review_file_changed');
   await client.query('UPDATE review_submissions SET completed_at=COALESCE(completed_at,NOW()) WHERE id=$1',[row.id]);
  }
  return recomputeBundleReviewStateInTx(client,target.orderSubmissionId);
 }
 return {recordReviewUploadInTx,completeReviewUploadInTx,
  stageReviewUpload:input=>withScope(input,(client,lockedScope)=>recordReviewUploadInTx({...input,client,lockedScope})),
  completeReviewUpload:input=>withScope(input,(client,lockedScope)=>completeReviewUploadInTx({...input,client,lockedScope}))};
}

module.exports={removeReviewEvidence,removeReviewEvidenceInTx,bundleTargetsForRows,withReviewFilesMutation,fileMutationContext,createService,bundleTargetForRow,recomputeBundleReviewStateInTx,
 stageReviewUpload:input=>createService().stageReviewUpload(input),
 completeReviewUpload:input=>createService().completeReviewUpload(input),
 recordReviewUploadInTx:input=>createService().recordReviewUploadInTx(input),
 completeReviewUploadInTx:input=>createService().completeReviewUploadInTx(input),loadBundle,identityEvidenceHash,evaluateBundleReviewCompletion,inspectionContextForOrder,digest,fail};
