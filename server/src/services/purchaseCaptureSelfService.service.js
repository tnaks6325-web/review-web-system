'use strict';
// Append-only reviewer evidence. Original purchase, identity and payout ledgers are read-only.
const {createHash,randomUUID}=require('node:crypto');
const lifecycle=require('./dualChannelLifecycle.service');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code,error,status=409)=>Object.assign(new Error(error),{code,status,error});
const publicRequest=r=>r?{id:r.id,status:r.status,createdAt:r.created_at??r.createdAt,updatedAt:r.updated_at??r.updatedAt,note:r.note||''}:null;
const unavailable=()=>fail('CAPTURE_UNAVAILABLE','사진 기록을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',503);
function createService({db,drive,requestInTx}={}){
 db=db||require('../db/pool');
 function checkCaller({session,actor,forStaff=false}){
  if(forStaff){if(!(actor?.id||actor?.name)||!['master','admin','staff'].includes(actor.role)||!require('../middleware/auth.middleware').isTrustedLoginToken(actor))throw fail('CAPTURE_STAFF_FORBIDDEN','담당자 로그인이 필요합니다.',403);return;}
  if(!session?.ownerReviewerId)throw fail('REVIEWER_AUTH_REQUIRED','리뷰어 로그인이 필요합니다.',401);
  if(!UUID.test(String(session.ownerReviewerId))||!/^\d{8}$/.test(session.loginPhone8||'')||!['self','sub'].includes(session.loginKind))throw fail('REVIEWER_AUTH_INVALID','다시 로그인해 주세요.',401);
 }
 async function authorize(client,order,{session,forStaff}){
  if(forStaff)return;
  if(!order.owner_reviewer_id)throw fail('CAPTURE_OWNERSHIP_UNKNOWN','이전 주문의 소유자를 확인할 수 없어요. 담당자에게 문의해 주세요.');
  if(String(order.owner_reviewer_id).toLowerCase()!==session.ownerReviewerId.toLowerCase())throw fail('CAPTURE_FORBIDDEN','본인 주문만 확인할 수 있어요.',403);
  const owner=(await client.query('SELECT id,phone8,sub_accounts FROM reviewers WHERE id=$1',[session.ownerReviewerId])).rows[0];
  if(!owner)throw fail('REVIEWER_AUTH_INVALID','다시 로그인해 주세요.',401);
  if(session.loginKind==='self'){
   if(owner.phone8!==session.loginPhone8)throw fail('REVIEWER_AUTH_INVALID','다시 로그인해 주세요.',401);
  }else{
   const identity=await require('./reviewerIdentity.service').resolveParticipantIdentity({client,ownerReviewerId:owner.id,participantPhone8:session.loginPhone8});
   const subs=Array.isArray(owner.sub_accounts)?owner.sub_accounts:[];
   if(!identity&&subs.filter(s=>String(s.phone||'').replace(/\D/g,'').slice(-8)===session.loginPhone8).length!==1)throw fail('REVIEWER_AUTH_INVALID','다시 로그인해 주세요.',401);
   if(!order.participant_identity_id&&!order.participant_card_id&&order.participant_identity_key_hash)throw fail('CAPTURE_OWNERSHIP_UNKNOWN','이전 주문의 참여 명의를 확인할 수 없어요. 담당자에게 문의해 주세요.');
   if(order.participant_identity_id ? !identity||identity.id!==order.participant_identity_id : String(order.phone||'').replace(/\D/g,'').slice(-8)!==session.loginPhone8)throw fail('CAPTURE_FORBIDDEN','현재 로그인한 명의의 주문만 확인할 수 있어요.',403);
  }
 }
 async function inspectInTx(client,{session,actor,orderSubmissionId,forStaff=false}){
  checkCaller({session,actor,forStaff});
  if(typeof orderSubmissionId!=='string'||!UUID.test(orderSubmissionId))throw fail('CAPTURE_ORDER_INVALID','주문을 다시 선택해 주세요.',404);
  const order=(await client.query('SELECT * FROM order_submissions WHERE id=$1 FOR UPDATE',[orderSubmissionId])).rows[0];
  if(!order)throw fail('CAPTURE_ORDER_NOT_FOUND','주문을 찾을 수 없어요.',404);
  await authorize(client,order,{session,forStaff});
  if(order.participant_identity_id){
   const identity=(await client.query('SELECT owner_reviewer_id FROM reviewer_identities WHERE id=$1',[order.participant_identity_id])).rows[0];
   if(!identity||identity.owner_reviewer_id!==order.owner_reviewer_id)throw fail('CAPTURE_AFFINITY_CHANGED','주문 명의 연결을 확인할 수 없어요. 담당자에게 문의해 주세요.');
  }
  if(order.participant_card_id){
   const card=await require('./reviewerIdentityCards.service').readOrderCardBinding(client,order.participant_card_id);
   if(!card||card.owner_reviewer_id!==order.owner_reviewer_id)throw fail('CAPTURE_AFFINITY_CHANGED','주문 명의 연결을 확인할 수 없어요. 담당자에게 문의해 주세요.');
   if(!forStaff&&session.loginKind==='sub'&&card.phone8!==session.loginPhone8)throw fail('CAPTURE_FORBIDDEN','현재 로그인한 명의의 주문만 확인할 수 있어요.',403);
  }
  const apps=(await client.query('SELECT * FROM campaign_applications WHERE id=ANY($1::int[]) ORDER BY id',[ [...new Set([order.campaign_application_id,order.purchase_bundle_application_id].filter(x=>x!=null))] ])).rows;
  const expectedApps=[...new Set([order.campaign_application_id,order.purchase_bundle_application_id].filter(x=>x!=null))];
  if(apps.length!==expectedApps.length||apps.some(a=>a.owner_reviewer_id!==order.owner_reviewer_id||a.order_submission_id&&a.order_submission_id!==order.id||a.participant_identity_id&&a.participant_identity_id!==order.participant_identity_id||a.participant_card_id&&a.participant_card_id!==order.participant_card_id))throw fail('CAPTURE_AFFINITY_CHANGED','주문 연결이 바뀌었어요. 담당자에게 문의해 주세요.');
  const campaignId=apps[0]?.campaign_id;
  const campaign=campaignId?(await client.query('SELECT * FROM recruit_campaigns WHERE id=$1',[campaignId])).rows[0]:null;
  if(apps.length&&(!campaign||apps.some(a=>a.campaign_id!==campaign.id)
   ||!((order.sheet_id==='campaign:'+campaign.id&&order.tab_name==='campaign:'+campaign.id)
    ||(order.sheet_id===campaign.linked_sheet_id&&(order.tab_name===campaign.linked_tab_name||order.gid&&order.gid===campaign.linked_tab_gid)))))throw fail('CAPTURE_AFFINITY_CHANGED','작업 연결을 확인할 수 없어요. 담당자에게 문의해 주세요.');
  if(order.purchase_bundle_version){
   const channels=(await client.query('SELECT channel FROM order_purchase_channels WHERE order_submission_id=$1 ORDER BY channel FOR UPDATE',[order.id])).rows;
   if(order.purchase_bundle_version!==1||channels.length!==2||channels[0].channel!=='coupang'||channels[1].channel!=='naver')throw fail('CAPTURE_AFFINITY_CHANGED','구매처 기록을 확인할 수 없어요. 담당자에게 문의해 주세요.');
  }
  const finishedSql=require('./reviewObligation.service').finishedTabSql('tc.sheet_id','tc.tab_name','tc.tab_gid');
  const configs=(await client.query(`SELECT tc.*,${finishedSql} AS finished,EXISTS(SELECT 1 FROM index_master_archive a WHERE a.sheet_id=tc.sheet_id AND a.tab_name=tc.tab_name) AS archived FROM tab_configs tc WHERE (sheet_id=$1 AND tab_name=$2) OR (sheet_id=$3 AND tab_name=$4)`,[order.sheet_id,order.tab_name,campaign?.linked_sheet_id||'',campaign?.linked_tab_name||''])).rows;
  const linked=configs.find(c=>c.sheet_id===campaign?.linked_sheet_id&&c.tab_name===campaign?.linked_tab_name);
  const direct=configs.find(c=>c.sheet_id===order.sheet_id&&c.tab_name===order.tab_name);
  const context={order,channels:order.purchase_bundle_version?['naver','coupang']:['single'],evidenceByChannel:{},displayName:campaign?.title||linked?.display_name||linked?.tab_name||direct?.display_name||order.tab_name||'구매 작업',participantName:order.recipient||order.orderer||'',session,actor,campaignThumb:campaign?campaign.thumbnail_url:undefined};
  const supplements=(await client.query('SELECT * FROM purchase_capture_supplements WHERE order_submission_id=$1 ORDER BY id',[order.id])).rows;
  const uploadSession=order.purchase_bundle_version?null:(await client.query('SELECT status,failure_code FROM purchase_submission_sessions WHERE order_submission_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 1',[order.id])).rows[0];
  const artifacts=order.purchase_bundle_version?(await client.query("SELECT * FROM purchase_capture_artifacts WHERE order_submission_id=$1 AND status='committed' AND superseded_at IS NULL ORDER BY channel,role,id FOR UPDATE",[order.id])).rows:[];
  for(const channel of context.channels){
   const originals=channel==='single'?[['original:1',order.capture_file_id,order.capture_uploaded_at],['original:2',order.capture_file_id_2,order.capture2_uploaded_at]].filter(x=>x[1]).map(([id,fileId,createdAt])=>({id,fileId,createdAt,isSupplement:false})):
    artifacts.filter(a=>a.channel===channel).map(a=>({id:a.id,fileId:a.file_id,createdAt:a.created_at,isSupplement:false}));
   const extra=supplements.filter(s=>s.channel===channel);
   const photos=[...originals,...extra.map(s=>({id:s.id,fileId:s.file_id,createdAt:s.created_at,isSupplement:true}))];
   const originalVersion=channel==='single'?[order.capture_file_id,order.capture_uploaded_at,order.capture_file_id_2,order.capture2_uploaded_at]:artifacts.filter(a=>a.channel===channel).map(a=>[a.id,a.role,a.revision,a.file_id,a.byte_sha256]);
   const known=!!(direct||linked);
   const active=known&&!order.deleted_at&&!['canceled','cancelled'].includes(order.mirror_status)&&!configs.some(c=>c.is_closed||c.finished||c.archived);
   context.evidenceByChannel[channel]={photos,evidenceHash:digest([order.id,channel,originalVersion,extra.map(s=>[s.id,s.file_id,s.byte_sha256])]),saveState:photos.length?'saved':uploadSession?.status==='failed'&&uploadSession.failure_code?'failed':uploadSession?.status==='uploading'?'uploading':'unknown',capabilities:{canSaveWithoutCheck:true,canAdd:active,canRequestCheck:active&&photos.length>0,reason:active?null:known?'진행이 종료된 주문이에요.':'작업 정보를 확인할 수 없어요. 담당자에게 문의해 주세요.'}};
  }
  return context;
 }
 async function viewInTx(client,context){
  const requests=(await client.query('SELECT * FROM purchase_capture_check_requests WHERE order_submission_id=$1 ORDER BY created_at DESC,id DESC',[context.order.id])).rows;
  const channels=context.channels.map(channel=>{
   const e=context.evidenceByChannel[channel],r=requests.find(r=>r.channel===channel&&r.evidence_hash===e.evidenceHash);
   return {channel,label:{single:'구매사진',naver:'네이버',coupang:'쿠팡'}[channel],photos:e.photos,evidenceHash:e.evidenceHash,saveState:e.saveState,
    reviewState:r?.status||'not_requested',reason:r?.status==='needs_photo'?r.note:context.order.purchase_bundle_version&&context.order.purchase_identity_review?.status==='pending'?'명의 확인은 별도로 진행 중이에요. 사진 확인과 입금 승인은 별개예요.':null,
    request:publicRequest(r),capabilities:e.capabilities};
  });
  return {orderSubmissionId:context.order.id,displayName:context.displayName,participantName:context.participantName,thumbnailUrl:await thumbnailInTx(client,context),channels};
 }
 // 리뷰어 창의 작은 상품 사진(결정 370) = 모집공고 카드와 같은 공고 썸네일. 참여 연결이 없는 작업 주문은 그 작업에 연결된 공고에서 찾는다.
 // https 주소만 내보낸다(화면이 그대로 <img src> 로 쓰므로). 없으면 null → 화면은 빈 자리 표시.
 async function thumbnailInTx(client,context){
  let url=context.campaignThumb;
  if(url===undefined){
   // 사진은 꾸밈이다 — 이 조회가 실패해도 목록·사진 처리 트랜잭션을 깨지 않게 SAVEPOINT 로 가둔다(실패 = 빈 자리).
   try{await client.query('SAVEPOINT purchase_capture_thumb');}catch(_){return null;}
   try{
    url=(await client.query(`SELECT thumbnail_url FROM recruit_campaigns
     WHERE (linked_sheet_id=$1 AND linked_tab_name=$2) OR $1='campaign:'||id
     ORDER BY (NULLIF(thumbnail_url,'') IS NULL),id DESC LIMIT 1`,[context.order.sheet_id,context.order.tab_name])).rows[0]?.thumbnail_url;
    await client.query('RELEASE SAVEPOINT purchase_capture_thumb');
   }catch(_){await client.query('ROLLBACK TO SAVEPOINT purchase_capture_thumb');await client.query('RELEASE SAVEPOINT purchase_capture_thumb');return null;}
  }
  url=String(url||'').trim();
  return /^https:\/\/[^\s"'<>\\]+$/.test(url)&&url.length<=2048?url:null;
 }
 async function withOrderTransaction(input,run){
  checkCaller(input);
  if(typeof input.orderSubmissionId!=='string'||!UUID.test(input.orderSubmissionId))throw fail('CAPTURE_ORDER_INVALID','주문을 다시 선택해 주세요.',404);
  try{
  const exists=(await db.query('SELECT id FROM order_submissions WHERE id=$1',[input.orderSubmissionId])).rows[0];
  if(!exists)throw fail('CAPTURE_ORDER_NOT_FOUND','주문을 찾을 수 없어요.',404);
  return await lifecycle.withDualLifecycleInTx({db,targets:[{orderSubmissionId:input.orderSubmissionId}],run:async client=>{
   await require('../utils/purchaseCaptureLock').lockPurchaseCaptureOrdersInTx(client,[input.orderSubmissionId]);
   return run(client,await inspectInTx(client,input));
  }});
  }catch(e){if(e.code&&[400,401,403,404,409,413,503].includes(e.status))throw fail(e.code,e.error||e.message,e.status);throw unavailable();}
 }
 const getForReviewer=({session,orderSubmissionId})=>withOrderTransaction({session,orderSubmissionId},async(client,context)=>({item:await viewInTx(client,context)}));
 async function listForReviewer({session,limit=20}){
  checkCaller({session});
  try{
   await authorize(db,{owner_reviewer_id:session.ownerReviewerId,phone:session.loginPhone8},{session});
   const pageSize=Math.max(1,Math.min(100,Math.trunc(Number(limit)||20))),scanLimit=Math.max(100,pageSize*4);
   const rows=(await db.query(`SELECT os.id FROM order_submissions os WHERE owner_reviewer_id=$1 AND deleted_at IS NULL
    AND mirror_status NOT IN ('canceled','cancelled') AND (submitted_at>now()-interval '14 days'
     OR EXISTS(SELECT 1 FROM purchase_capture_check_requests r WHERE r.order_submission_id=os.id
       AND (r.status IN ('pending','needs_photo') OR r.updated_at>now()-interval '14 days')))
    ORDER BY submitted_at DESC,id DESC LIMIT $2`,[session.ownerReviewerId,scanLimit+1])).rows;
   const items=[];
   for(const row of rows.slice(0,scanLimit)){
    let item;
    try{item=(await getForReviewer({session,orderSubmissionId:row.id})).item;}
    catch(e){if(session.loginKind==='sub'&&e.code==='CAPTURE_FORBIDDEN')continue;throw e;}
    if(item.channels.some(c=>c.capabilities.canAdd))items.push(item);
    if(items.length>pageSize)break;
   }
   return {items:items.slice(0,pageSize),hasMore:items.length>pageSize||rows.length>scanLimit};
  }catch(e){if(e.code&&[401,403,404,409,413,503].includes(e.status))throw fail(e.code,e.error||e.message,e.status);throw unavailable();}
 }
 async function addSupplement(input){
  const {session,orderSubmissionId,channel,imageBase64,mimeType,requestKey}=input;
  checkCaller({session});
  const hasRequestCheck=Object.hasOwn(input,'requestCheck');
  if(hasRequestCheck&&typeof input.requestCheck!=='boolean')throw fail('CAPTURE_REQUEST_INVALID','사진 확인 요청 여부를 다시 선택해 주세요.',400);
  if(typeof requestKey!=='string'||!UUID.test(requestKey))throw fail('CAPTURE_REQUEST_INVALID','요청 번호가 올바르지 않아요. 다시 시도해 주세요.');
  // Absent-field retries keep the pre-opt-in digest, including committed checked uploads.
  const payload=[imageBase64,mimeType,input.expectedEvidenceHash];
  if(hasRequestCheck)payload.push(input.requestCheck);
  const payloadHash=digest(payload);
  function validate(context){
   if(!hasRequestCheck)throw fail('CAPTURE_REFRESH_REQUIRED','사진 저장 기능이 바뀌었어요. 새로고침 후 다시 저장해 주세요.');
   if(!context.channels.includes(channel))throw fail('CAPTURE_CHANNEL_INVALID','이 주문의 구매처를 다시 선택해 주세요.');
   if(!context.evidenceByChannel[channel].capabilities.canAdd)throw fail('CAPTURE_ORDER_CLOSED','진행이 종료된 주문이라 사진을 추가할 수 없어요.');
   if(context.evidenceByChannel[channel].evidenceHash!==input.expectedEvidenceHash)throw fail('CAPTURE_EVIDENCE_CHANGED','사진이 바뀌었어요. 새로고침한 뒤 다시 확인해 주세요.');
  }
  const priorInTx=async(client,context)=>{
   const prior=(await client.query('SELECT * FROM purchase_capture_supplements WHERE order_submission_id=$1 AND channel=$2 AND request_key=$3',[context.order.id,channel,requestKey])).rows[0];
   if(!prior)return null;
   if(prior.request_payload_hash!==payloadHash)throw fail('CAPTURE_REQUEST_CONFLICT','같은 요청 번호로 다른 사진을 보낼 수 없어요.');
   const r=prior.check_request_id==null?null:(await client.query('SELECT * FROM purchase_capture_check_requests WHERE id=$1',[prior.check_request_id])).rows[0];
   if(prior.check_request_id!=null&&!r)throw unavailable();
   return {item:await viewInTx(client,context),request:publicRequest(r),created:false};
  };
  const initial=await withOrderTransaction({session,orderSubmissionId},async(client,context)=>{const replay=await priorInTx(client,context);if(!replay)validate(context);return {context,replay};});
  if(initial.replay)return initial.replay;
  if(typeof imageBase64!=='string')throw fail('CAPTURE_IMAGE_INVALID','사진 파일을 다시 선택해 주세요.');
  if(imageBase64.length>12*1024*1024)throw fail('CAPTURE_IMAGE_TOO_LARGE','사진은 8MB 이하로 보내 주세요.',413);
  let bytes;
  try{bytes=require('./dualPurchaseProof.service').bytes(imageBase64);}catch(_){throw fail('CAPTURE_IMAGE_INVALID','사진 파일을 다시 선택해 주세요.');}
  if(bytes.length>8*1024*1024)throw fail('CAPTURE_IMAGE_TOO_LARGE','사진은 8MB 이하로 보내 주세요.',413);
  const signature={
   'image/png':()=>bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
   'image/jpeg':()=>bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
   'image/webp':()=>bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP',
   'image/gif':()=>bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)),
  };
  if(!Object.hasOwn(signature,mimeType)||!signature[mimeType]())throw fail('CAPTURE_IMAGE_INVALID','사진 파일을 다시 선택해 주세요.');
  const byteHash=createHash('sha256').update(bytes).digest('hex');
  let folder;
  const storage=drive||{
   upload:async(bytes,mime,folderId)=>(await require('./drive.service').uploadFileBase64(bytes.toString('base64'),'purchase-supplement__'+randomUUID(),mime,folderId)).id,
   read:async id=>(await require('./drive.service').downloadFile(id)).buffer
  };
  if(!drive){
   const rootFolderId=process.env.AI_REVIEW_FOLDER_ID||process.env.DRIVE_ROOT_FOLDER_ID;
   if(!rootFolderId)throw unavailable();
   folder=(await require('./captureFolder.service').resolveCaptureFolder({sheetId:initial.context.order.sheet_id,tabName:initial.context.order.tab_name,rootFolderId})).folderId;
  }
  let fileId;
  try{
   fileId=await storage.upload(bytes,mimeType,folder);
   const actual=fileId&&await storage.read(fileId);
   if(!Buffer.isBuffer(actual)||createHash('sha256').update(actual).digest('hex')!==byteHash)throw fail('CAPTURE_UPLOAD_UNVERIFIED','새 사진의 저장을 확인하지 못했어요. 다시 시도해 주세요.',503);
  }catch(e){if(e.code==='CAPTURE_UPLOAD_UNVERIFIED')throw e;throw unavailable();}
  // No deletion on failure: a lost COMMIT response or reused file ID must not destroy evidence.
  const outcome=await withOrderTransaction({session,orderSubmissionId},async(client,before)=>{
   const replay=await priorInTx(client,before);if(replay)return replay;validate(before);
   const added=await client.query(`INSERT INTO purchase_capture_supplements(order_submission_id,channel,file_id,byte_sha256,mime_type,request_key,request_payload_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[orderSubmissionId,channel,fileId,byteHash,mimeType,requestKey,payloadHash,session.ownerReviewerId]);
   const context=await inspectInTx(client,{session,orderSubmissionId});
   if(input.requestCheck!==true)return {item:await viewInTx(client,context),request:null,created:false};
   const requested=await (requestInTx||require('./purchaseCaptureCheck.service').requestInTx)(client,{context,channel,note:'구매사진을 추가했어요. 사진 확인을 부탁드려요.'});
   await client.query('UPDATE purchase_capture_supplements SET check_request_id=$2 WHERE id=$1',[added.rows[0].id,requested.request.id]);
   return {item:await viewInTx(client,context),request:publicRequest(requested.request),created:requested.created===true,...(requested.created&&requested.notification?{notification:requested.notification}:{})};
  });
  try{await require('./purchaseCaptureCheck.service').notifyCreated(outcome);}catch(_){/* Storage committed: notification failure must not relabel or repeat the save. */}
  return outcome;
 }
 function safe(fn){return async(...args)=>{try{return await fn(...args);}catch(e){if(e.code&&[400,401,403,404,409,413,503].includes(e.status))throw fail(e.code,e.error||e.message,e.status);throw unavailable();}};}
 return Object.fromEntries(Object.entries({getForReviewer,listForReviewer,addSupplement,withOrderTransaction,inspectInTx,viewInTx}).map(([name,fn])=>[name,safe(fn)]));
}
let production;
const get=()=>production||(production=createService());
module.exports={createService,...Object.fromEntries(['getForReviewer','listForReviewer','addSupplement','withOrderTransaction','inspectInTx','viewInTx'].map(name=>[name,(...args)=>get()[name](...args)]))};
