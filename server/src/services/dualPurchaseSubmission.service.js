'use strict';
const {randomUUID}=require('crypto');
const proof=require('./dualPurchaseProof.service');
const channels=['naver','coupang'];
const commands=new WeakMap();
const identityDefault=require('./reviewerOrderIdentity.service');
const {addressHeuristic}=require('./identity.service');
const mask=/[*＊●○◯◉•·xX]/;
function cleanPurchase(p={}) {
 const out={};
 for(const key of ['orderNum','userId','recipient','phone','address']) {
  if(typeof p[key]!=='string' || !p[key].trim() || p[key].length>500) proof.fail('DUAL_FIELDS_REQUIRED');
  out[key]=p[key].trim();
 }
 if(!Number.isSafeInteger(p.paidAmount) || p.paidAmount<0 || p.paidAmount>2147483647) proof.fail('DUAL_AMOUNT_INVALID');
 out.paidAmount=p.paidAmount;return out;
}
function createService(deps={}) {
 const db=deps.db || require('../db/pool');
 const identity=deps.identity || identityDefault;
 const runtime=()=>deps.runtime || require('./dualChannelRuntime.service');
 const lifecycle=()=>deps.lifecycle || require('./dualChannelLifecycle.service');
 const drive=deps.drive || {
  upload:async(b,mime,folder)=>{
   const r=await require('./drive.service').uploadFileBase64(b.toString('base64'),'dual-'+randomUUID(),mime,folder);return r.id;
  },
  read:async id=>{const r=await require('./drive.service').downloadFile(id);return r.buffer;},
 };
 function contextArgs(body,reviewerSession){
  if(!reviewerSession?.ownerReviewerId) proof.fail('REVIEWER_AUTH_REQUIRED','리뷰어 로그인 확인이 필요합니다.',401);
  // The reviewer UI carries the application id from its query string. Only canonical digits are accepted.
  const raw=body.campaignApplicationId,applicationId=typeof raw==='string'&&/^[1-9][0-9]{0,9}$/.test(raw)&&Number(raw)<=2147483647?Number(raw):raw;
  return {ownerReviewerId:reviewerSession.ownerReviewerId,applicationId,campaignId:body.campaignId,holdToken:body.campaignHoldToken};
 }
 async function context(body,reviewerSession,client=db){
  const args=contextArgs(body,reviewerSession);
  if(!Number.isSafeInteger(args.applicationId)||args.applicationId<1)proof.fail('DUAL_APPLICATION_INVALID');
  const a=(await client.query('SELECT campaign_id FROM campaign_applications WHERE id=$1',[args.applicationId])).rows[0];
  if(!a?.campaign_id)proof.fail('DUAL_APPLICATION_INVALID');
  // Campaign affiliation comes only from the application, never the HTTP body.
  return identity.resolveApplicationIdentity({...args,campaignId:a.campaign_id},client);
 }
 async function condition(client,ctx){
  // 현금영수증 필요 = 공고 직접 설정 OR 연결 작업표 진행방식 '현영' — 리뷰어 구매 안내(campaign.routes _cashReceiptInfo)와 같은 기준.
  const r=await client.query(`SELECT rc.work_detail,to_jsonb(rc)->'cash_receipt_required' AS cash_receipt_required,
    (SELECT tc.income_type FROM tab_configs tc WHERE tc.sheet_id=rc.linked_sheet_id AND tc.tab_name=rc.linked_tab_name LIMIT 1) AS income_type
    FROM recruit_campaigns rc WHERE rc.id=$1`,[ctx.application.campaign_id]);
  const product=r.rows[0]?.work_detail?.dualChannelProduct;
  if(!product?.channels?.naver || !product?.channels?.coupang) proof.fail('DUAL_CONDITION_MISSING');
  const cashReceiptRequired=r.rows[0].cash_receipt_required===true || String(r.rows[0].income_type||'').includes('현영');
  return {...product,cashReceiptRequired};
 }
 async function inTx(body,run){
  return lifecycle().withDualLifecycleInTx({db,targets:[{applicationId:body.campaignApplicationId}],run});
 }
 async function extractPurchase({body,reviewerSession}){
  runtime().assertDualChannelReady('purchase');
  const ctx=await context(body,reviewerSession);
  proof.bytes(body.imageBase64);proof.scope({...body,context:ctx});
  let r;
  try{r=await (deps.extractAI || require('./gemini.service').extractOrderFromImage)(body.imageBase64,body.mimeType,{allowSecondCapture:body.role==='supplement'});}
  catch(_){r={ok:false,data:{}};}
  const extracted=r.data || r.extracted || r;
  return {...proof.issueChannelExtraction({...body,context:ctx,extracted,ok:r.ok===true}),extracted,extractionOk:r.ok===true};
 }
 async function resolveFolder(ctx){
  if(deps.resolveFolder)return deps.resolveFolder(ctx);
  const rootFolderId=process.env.AI_REVIEW_FOLDER_ID||process.env.DRIVE_ROOT_FOLDER_ID;
  if(!rootFolderId)proof.fail('DUAL_DRIVE_NOT_CONFIGURED');
  const r=await require('./captureFolder.service').resolveCaptureFolder({sheetId:'campaign:'+ctx.application.campaign_id,tabName:'campaign:'+ctx.application.campaign_id,rootFolderId});return r.folderId;
 }
 async function stagePurchaseArtifact({body,reviewerSession}){
  runtime().assertDualChannelReady('purchase');
  // Short prepare / external I/O / short revalidation. No transaction spans Drive.
  const prepare=async client=>{
   const ctx=await context(body,reviewerSession,client),purchase=cleanPurchase(body.purchase);
   const extracted=proof.verifyChannelExtraction({...body,context:ctx});
   let approved;
   if(body.role==='supplement'){
    const primary=(await client.query("SELECT extraction_json,final_input_hash FROM purchase_capture_artifacts WHERE application_id=$1 AND channel=$2 AND role='primary' AND superseded_at IS NULL AND status IN ('staged','committed')",[ctx.application.id,body.channel])).rows[0];
    if(!primary||primary.final_input_hash!==proof.hash(purchase))proof.fail('DUAL_PRIMARY_REQUIRED');
    approved={approval:primary.extraction_json.approval};
    if(approved.approval.ownerReviewerId!==ctx.owner.id||approved.approval.profileHash!==identity._test.profileHash(ctx.selected)||approved.approval.selectedIdentityHash!==identity._test.stableHash(ctx.selected.identityKey))proof.fail('DUAL_IDENTITY_CHANGED');
   }else{
    approved=await identity.verifyApprovalForSubmission({...purchase,identityApprovalToken:body.identityApprovalToken,
     campaignApplicationId:body.campaignApplicationId,campaignId:ctx.application.campaign_id,holdToken:body.campaignHoldToken},reviewerSession,client);
    if(approved.approval.mode!=='no_capture' && (approved.approval.imageHash!==identity.hashImageBase64(body.imageBase64)
     || approved.approval.extractedFieldsHash!==identity.fieldsHash(body.extracted)))proof.fail();
   }
   const snapshot=await condition(client,ctx),byteSha256=extracted.byteSha256;
   const shaGuard=require('../utils/dualEvidenceShaLock');
   await shaGuard.lockEvidenceShaInTx(client,byteSha256);
   if((await shaGuard.evidenceShaUsesInTx(client,byteSha256)).some(u=>u.kind==='review'))proof.fail('DUAL_IMAGE_REUSED');
   const used=(await client.query('SELECT * FROM purchase_capture_artifacts WHERE byte_sha256=$1 ORDER BY id FOR UPDATE',[byteSha256])).rows;
   for(const r of used)if(r.application_id!==ctx.application.id||r.channel!==body.channel||r.role!==body.role)proof.fail('DUAL_IMAGE_REUSED');
   const finalInputHash=proof.hash(purchase),conditionHash=proof.hash(snapshot);
   const current=(await client.query("SELECT * FROM purchase_capture_artifacts WHERE application_id=$1 AND channel=$2 AND role=$3 AND superseded_at IS NULL AND status IN ('staged','committed') FOR UPDATE",[ctx.application.id,body.channel,body.role])).rows[0];
   if(current?.byte_sha256===byteSha256&&current.final_input_hash===finalInputHash&&current.revision===body.revision&&current.condition_snapshot_hash===conditionHash)return {existing:current};
   if(current&&(current.status==='committed'||body.expectedArtifactId!==current.id||body.revision!==current.revision+1))proof.fail('DUAL_ARTIFACT_CHANGED');
   if(!current&&(body.revision!==1||body.expectedArtifactId))proof.fail('DUAL_ARTIFACT_REVISION');
   return {ctx,purchase,extracted,approved,snapshot,byteSha256,finalInputHash,conditionHash,current};
  };
  const initial=await inTx(body,prepare);if(initial.existing)return initial.existing;
  const folder=await resolveFolder(initial.ctx);
  const fileId=await drive.upload(proof.bytes(body.imageBase64),body.mimeType,folder);
  if(!fileId||proof.sha(await drive.read(fileId))!==initial.byteSha256)proof.fail('DUAL_FILE_BYTES_CHANGED');
  // Never delete on an unknown COMMIT result; all prior versions stay recoverable.
  return inTx(body,async client=>{
   const p=await prepare(client);if(p.existing)return p.existing;
   if(p.conditionHash!==initial.conditionHash||p.finalInputHash!==initial.finalInputHash||p.current?.id!==initial.current?.id)proof.fail('DUAL_ARTIFACT_CHANGED');
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['dual-artifact:file:'+fileId]);
   if((await client.query('SELECT id FROM purchase_capture_artifacts WHERE file_id=$1',[fileId])).rows.length)proof.fail('DUAL_FILE_REUSED');
   if(p.current)await client.query("UPDATE purchase_capture_artifacts SET superseded_at=now(),status='superseded' WHERE id=$1",[p.current.id]);
   const r=await client.query(`INSERT INTO purchase_capture_artifacts
    (id,application_id,channel,role,revision,file_id,byte_sha256,extraction_json,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'staged',$12) RETURNING *`,
    [randomUUID(),p.ctx.application.id,body.channel,body.role,body.revision,fileId,p.byteSha256,{extracted:body.extracted,scope:p.extracted.scope,approval:p.approved.approval,ok:p.extracted.ok!==false},proof.sha(body.extractionToken),p.finalInputHash,p.conditionHash,String(p.ctx.owner.id)]);
   return r.rows[0];
  });
 }
 async function verifiedFiles(body){
  const files=new Map();
  for(const channel of channels)for(const key of ['primaryArtifactId','supplementArtifactId']){
   const id=body.purchases?.[channel]?.[key];if(!id)continue;
   const r=(await db.query('SELECT id,file_id,byte_sha256 FROM purchase_capture_artifacts WHERE id=$1',[id])).rows[0];
   if(!r||proof.sha(await drive.read(r.file_id))!==r.byte_sha256)proof.fail('DUAL_FILE_BYTES_CHANGED');
   files.set(id,{fileId:r.file_id,sha:r.byte_sha256});
  }
  return files;
 }
 async function inspectBundle(body,reviewerSession,client,files){
  const ctx=await context(body,reviewerSession,client);const snapshot=await condition(client,ctx);
  const purchases={},artifacts=[];
  for(const channel of channels){
   const p=body.purchases?.[channel];if(!p?.primaryArtifactId) proof.fail('DUAL_TWO_PRIMARY_REQUIRED');
   purchases[channel]=cleanPurchase(p);
   for(const [role,id] of [['primary',p.primaryArtifactId],['supplement',p.supplementArtifactId]]){
    if(!id)continue;
    const r=(await client.query('SELECT * FROM purchase_capture_artifacts WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!r || r.application_id!==ctx.application.id || r.channel!==channel || r.role!==role || r.superseded_at || !['staged','committed'].includes(r.status)
     || r.final_input_hash!==proof.hash(purchases[channel]) || r.condition_snapshot_hash!==proof.hash(snapshot)) proof.fail('DUAL_ARTIFACT_STALE');
    if(files?.get(r.id)?.fileId!==r.file_id || files.get(r.id).sha!==r.byte_sha256) proof.fail('DUAL_FILE_BYTES_CHANGED');
    const a=r.extraction_json.approval;
    if(a.ownerReviewerId!==ctx.owner.id || a.selectedIdentityHash!==identity._test.stableHash(ctx.selected.identityKey)
     || a.profileHash!==identity._test.profileHash(ctx.selected)) proof.fail('DUAL_IDENTITY_CHANGED');
    artifacts.push(r);
   }
  }
  let verdict='match';
  const compare=(a,b)=>{
   for(const k of ['recipient','phone']){
    const norm=v=>String(v||'').replace(k==='phone'?/\D/g:/\s/g,'');
    if(!a[k]||!b[k]||mask.test(a[k])||mask.test(b[k])){verdict='uncertain';continue;}
    if(norm(a[k])!==norm(b[k]))proof.fail('DUAL_IDENTITY_MISMATCH');
   }
   if(!a.address||!b.address||mask.test(a.address)||mask.test(b.address)){verdict='uncertain';return;}
   const v=addressHeuristic(a.address,b.address).verdict;
   if(v==='mismatch')proof.fail('DUAL_ADDRESS_MISMATCH');if(v!=='match')verdict='uncertain';
  };
  compare(purchases.naver,purchases.coupang);
  const primary=channels.map(channel=>artifacts.find(a=>a.channel===channel&&a.role==='primary').extraction_json);
  if(primary.some(a=>a.ok===false||['no_capture','ai_error','match_error'].includes(a.approval.mode)))verdict='uncertain';
  else compare(primary[0].extracted,primary[1].extracted);
  const captureFlags=[];
  for(const channel of channels){
   const a=artifacts.find(a=>a.channel===channel&&a.role==='primary').extraction_json;
   const d=require('./capturePriceCheck.service').decideForExpected({channel,expected:snapshot.channels[channel].pay,capturePrice:a.ok===false?'':a.extracted.price,typedPrice:purchases[channel].paidAmount,staffReview:body.purchases[channel].capturePriceStaffReview===true,ack:body.purchases[channel].capturePriceAck===true});
   if(d.action==='block'||d.action==='warn')proof.fail(d.action==='block'?'CAPTURE_PRICE_OVER':'CAPTURE_PRICE_DIFF',d.error);
   if(d.action==='flag')captureFlags.push({channel,...d});
  }
  const input={applicationId:ctx.application.id,purchases,captureFlags,artifactRefs:artifacts.map(a=>({id:a.id,revision:a.revision,sha:a.byte_sha256})),bank:body.bank,account:body.account,depositor:body.depositor};
  for(const k of ['bank','account','depositor'])if(typeof input[k]!=='string'||!input[k].trim())proof.fail('DUAL_ACCOUNT_REQUIRED');
  return {ctx,snapshot,purchases,artifacts,verdict,captureFlags,input,hash:proof.hash(input)};
 }
 async function issueBundleApproval({body,reviewerSession}){
  runtime().assertDualChannelReady('purchase');
  await context(body,reviewerSession);const files=await verifiedFiles(body);
  return inTx(body,async c=>{const b=await inspectBundle(body,reviewerSession,c,files);return {bundleApprovalToken:proof.sign('bundle',{inputHash:b.hash,conditionHash:proof.hash(b.snapshot),owner:b.ctx.owner.id}),identityResult:b.verdict};});
 }
 async function prepareBundle({body,reviewerSession}){
  runtime().assertDualChannelReady('purchase');
  const pre=await context(body,reviewerSession);
  const existing=(await db.query('SELECT id FROM order_submissions WHERE purchase_bundle_application_id=$1',[pre.application.id])).rows[0];
  const files=existing?new Map():await verifiedFiles(body);
  return inTx(body,async c=>{
   const ctx=await context(body,reviewerSession,c),signed=proof.verify(body.bundleApprovalToken,'bundle');
   const prior=(await c.query('SELECT * FROM order_submissions WHERE purchase_bundle_application_id=$1 FOR UPDATE',[ctx.application.id])).rows[0];
   if(prior&&signed.inputHash===prior.purchase_bundle_hash){
    if(prior.deleted_at||prior.mirror_status==='canceled')proof.fail('DUAL_BUNDLE_CANCELLED');
    const purchases={},artifactRefs=[];
    for(const channel of channels){
     const p=body.purchases?.[channel];purchases[channel]=cleanPurchase(p);
     if(!p.primaryArtifactId)proof.fail('DUAL_TWO_PRIMARY_REQUIRED');
     for(const [role,id] of [['primary',p.primaryArtifactId],['supplement',p.supplementArtifactId]]){
      if(!id)continue;
      const a=(await c.query('SELECT * FROM purchase_capture_artifacts WHERE id=$1',[id])).rows[0];
      if(!a||a.application_id!==ctx.application.id||a.order_submission_id!==prior.id||a.channel!==channel||a.role!==role||a.final_input_hash!==proof.hash(purchases[channel]))proof.fail('DUAL_BUNDLE_CONFLICT');
      artifactRefs.push({id:a.id,revision:a.revision,sha:a.byte_sha256});
     }
    }
    const input={applicationId:ctx.application.id,purchases,artifactRefs,captureFlags:prior.capture_flags?.flags||[],bank:body.bank,account:body.account,depositor:body.depositor};
    if(proof.hash(input)!==prior.purchase_bundle_hash||signed.owner!==ctx.owner.id||prior.owner_reviewer_id!==ctx.owner.id||signed.conditionHash!==proof.hash(prior.purchase_condition_snapshot))proof.fail('DUAL_BUNDLE_CONFLICT');
    const command=Object.freeze({});commands.set(command,{body:JSON.parse(JSON.stringify(body)),reviewerSession:{...reviewerSession},hash:prior.purchase_bundle_hash,service:api});return command;
   }
   if(prior)proof.fail('DUAL_BUNDLE_CONFLICT');
   const b=await inspectBundle(body,reviewerSession,c,files);
   if(signed.inputHash!==b.hash || signed.owner!==b.ctx.owner.id || signed.conditionHash!==proof.hash(b.snapshot))proof.fail();
   const command=Object.freeze({});commands.set(command,{body:JSON.parse(JSON.stringify(body)),reviewerSession:{...reviewerSession},hash:b.hash,service:api});return command;
  });
 }
 async function persistBundle(input){
  runtime().assertDualChannelReady('purchase');
  const command=commands.get(input.purchaseBundle);if(!command || command.service!==api)proof.fail('DUAL_COMMAND_REQUIRED');
  const pre=await context(command.body,command.reviewerSession);
  const existing=(await db.query('SELECT id FROM order_submissions WHERE purchase_bundle_application_id=$1',[pre.application.id])).rows[0];
  const files=existing?new Map():await verifiedFiles(command.body);
  return inTx(command.body,async (client,lockedScope)=>{
   const ctx=await context(command.body,command.reviewerSession,client);
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['dual-bundle:'+ctx.application.id]);
   const prior=(await client.query('SELECT * FROM order_submissions WHERE purchase_bundle_application_id=$1 FOR UPDATE',[ctx.application.id])).rows[0];
   if(prior){if(prior.purchase_bundle_hash!==command.hash||prior.owner_reviewer_id!==ctx.owner.id)proof.fail('DUAL_BUNDLE_CONFLICT');if(prior.deleted_at||prior.mirror_status==='canceled')proof.fail('DUAL_BUNDLE_CANCELLED');return {orderSubmissionId:prior.id,idempotent:true,holdResult:ctx.application.status==='submitted'?'confirmed':null,dedupKey:'osid:'+prior.id,sheetRow:prior.sheet_row||null,claim:{row:prior.sheet_row||null,error:'workboard_apply_pending'},tabContext:null,tabGid:prior.tab_gid||'',headers:[]};}
   const b=await inspectBundle(command.body,command.reviewerSession,client,files);
   if(b.hash!==command.hash)proof.fail();
   const n=b.purchases.naver;const price=b.purchases.naver.paidAmount+b.purchases.coupang.paidAmount;
   if(!Number.isSafeInteger(price)||price>2147483647)proof.fail('DUAL_AMOUNT_INVALID');
   const ins=await client.query(`INSERT INTO order_submissions
    (sheet_id,tab_name,gid,tab_gid,orderer,recipient,user_id,phone,address,order_num,bank,account,depositor,price,source,dedup_key,mirror_status,
     owner_reviewer_id,participant_card_id,participant_identity_key_hash,purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_identity_review,purchase_bundle_revision)
    VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'order_submit',NULL,'pending',$14,$15,$16,1,$17,$18,$19,$20,$21,1) RETURNING id`,
    [input.sheetId,input.tabName,input.gid||'',b.ctx.owner.name,n.recipient,n.userId,n.phone,n.address,n.orderNum,
     command.body.bank,command.body.account,command.body.depositor,String(price),b.ctx.owner.id,b.ctx.selected.cardId||null,identity._test.stableHash(b.ctx.selected.identityKey),b.ctx.application.id,b.hash,b.snapshot,b.verdict,{status:b.verdict==='uncertain'?'pending':'not_required'}]);
   const orderSubmissionId=ins.rows[0].id;
   await client.query('UPDATE order_submissions SET capture_flags=$2,date_str=$3,dedup_key=$4,participant_identity_id=$5 WHERE id=$1',[orderSubmissionId,b.captureFlags.length?{flags:b.captureFlags}:null,require('./manualOrder.service').todayKstDateStr(),'osid:'+orderSubmissionId,b.ctx.selected.participantIdentityId||null]);
   for(const channel of channels){const p=b.purchases[channel];await client.query(`INSERT INTO order_purchase_channels(order_submission_id,channel,order_num,user_id,recipient,phone,address,paid_amount,identity_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[orderSubmissionId,channel,p.orderNum,p.userId,p.recipient,p.phone,p.address,p.paidAmount,{result:b.verdict}]);}
   const attributed=await client.query(`UPDATE purchase_capture_artifacts SET order_submission_id=$1,status='committed' WHERE id=ANY($2::uuid[]) AND order_submission_id IS NULL RETURNING id`,[orderSubmissionId,b.artifacts.map(a=>a.id)]);
   if(attributed.rows.length!==b.artifacts.length)proof.fail('DUAL_ARTIFACT_OWNED');
   const sum=(await client.query('SELECT count(*)::int AS n,sum(paid_amount)::int AS total FROM order_purchase_channels WHERE order_submission_id=$1',[orderSubmissionId])).rows[0];
   if(sum.n!==2 || sum.total!==price)proof.fail('DUAL_TOTAL_INVALID');
   // Bind the automatic identity verdict to the evidence it was computed from (payout rechecks this hash).
   const reviewSvc=require('./dualChannelReview.service');
   const submittedEvidenceHash=reviewSvc.identityEvidenceHash(await reviewSvc.loadBundle(client,orderSubmissionId));
   await client.query("UPDATE order_submissions SET purchase_identity_review=COALESCE(purchase_identity_review,'{}'::jsonb)||jsonb_build_object('submittedEvidenceHash',$2::text) WHERE id=$1",[orderSubmissionId,submittedEvidenceHash]);
   await client.query('SAVEPOINT hold_confirm');let holdResult;
   try{holdResult=await(deps.confirmHoldInTx || require('./campaignHold.service').confirmHoldInTx)(client,{applicationId:b.ctx.application.id,campaignId:b.ctx.application.campaign_id,holdToken:command.body.campaignHoldToken,phone8:b.ctx.application.phone8,orderSubmissionId,sheetId:input.sheetId,tabName:input.tabName,gid:input.gid,lockedScope});await client.query('RELEASE SAVEPOINT hold_confirm');}
   catch(_){await client.query('ROLLBACK TO SAVEPOINT hold_confirm');holdResult='error';}
   return {orderSubmissionId,holdResult,dedupKey:'osid:'+orderSubmissionId,sheetRow:null,claim:{row:null,error:'workboard_apply_pending'},tabContext:null,tabGid:input.gid||'',headers:[]};
  });
 }
 const api={extractPurchase,stagePurchaseArtifact,issueBundleApproval,prepareBundle,persistBundle};return api;
}
let production;
const get=()=>production || (production=createService());
module.exports={createService,cleanPurchase,extractPurchase:args=>get().extractPurchase(args),stagePurchaseArtifact:args=>get().stagePurchaseArtifact(args),issueBundleApproval:args=>get().issueBundleApproval(args),prepareBundle:args=>get().prepareBundle(args),persistBundle:input=>{const c=commands.get(input.purchaseBundle);if(!c)proof.fail('DUAL_COMMAND_REQUIRED');return c.service.persistBundle(input);}};
