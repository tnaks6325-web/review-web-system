'use strict';

function fault(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code, error: message });
}
function publicRequest(row) {
  return { id: row.id, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, note: row.note };
}
function cleanNote(note) {
  if (note == null) return '';
  if (typeof note !== 'string' || note.length > 1000) throw fault(400, 'INVALID_NOTE', '메모는 1000자 이내로 입력해주세요.');
  return note.trim();
}
function evidence(context, channel) {
  const entry = ['single','naver','coupang'].includes(channel) && context.evidenceByChannel?.[channel];
  if (!entry || !entry.evidenceHash) throw fault(409, 'CAPTURE_UNAVAILABLE', '현재 사진 정보를 다시 확인해주세요.');
  return entry.evidenceHash;
}

async function notifyCreated(result) {
  if (result?.created && result.notification) require('../utils/sse').emitCsInquiry(result.notification);
}
function createService({ db, core, notify = notifyCreated } = {}) {
  if (!db) throw new TypeError('db is required');
  const getCore = () => core || (core = require('./purchaseCaptureSelfService.service').createService({db}));
  async function requestInTx(client, { context, channel, note }) {
    // Caller owns the transaction and core order/lifecycle locks. Never begin/commit here.
    const hash = evidence(context, channel);
    const textNote = cleanNote(note);
    // Replays are reads: a pending/confirmed card may intentionally disable new requests.
    // Ownership and lifecycle checks still run in the core transaction before this lookup.
    const replay = (await client.query(`SELECT * FROM purchase_capture_check_requests
      WHERE order_submission_id=$1 AND channel=$2 AND evidence_hash=$3`,[context.order.id,channel,hash])).rows[0];
    if (replay) return {request:publicRequest(replay),created:false};
    if (context.evidenceByChannel[channel].capabilities?.canRequestCheck !== true) {
      throw fault(409,'CAPTURE_CHECK_BLOCKED','지금은 사진 확인을 요청할 수 없습니다.');
    }
    const { rows } = await client.query(`INSERT INTO purchase_capture_check_requests
      (order_submission_id,channel,evidence_hash,note) VALUES($1,$2,$3,$4)
      ON CONFLICT(order_submission_id,channel,evidence_hash) DO NOTHING RETURNING *`,
    [context.order.id, channel, hash, textNote]);
    if (!rows.length) {
      const existing = (await client.query(`SELECT * FROM purchase_capture_check_requests
        WHERE order_submission_id=$1 AND channel=$2 AND evidence_hash=$3`,[context.order.id,channel,hash])).rows[0];
      return { request: publicRequest(existing), created: false };
    }
    const row = rows[0];
    // Resolve the authenticated owner from SQL, never a participant phone or raw payload.
    const ownerId = context.order.owner_reviewer_id || context.session?.ownerReviewerId;
    const owner = (await client.query('SELECT name,phone FROM reviewers WHERE id=$1',[ownerId])).rows[0];
    const phone8 = String(owner?.phone || '').replace(/\D/g,'').slice(-8);
    if (!/^\d{8}$/.test(phone8)) throw fault(409,'CS_RECIPIENT_UNAVAILABLE','문의받을 본계정 정보를 확인할 수 없습니다.');
    const campaignKey = require('./csBridge.service').campaignKeyOf(context.order.sheet_id,context.order.tab_name);
    const content = '구매 사진 확인을 요청했습니다.' + (textNote ? `\n${textNote}` : '');
    const thread = (await client.query(`INSERT INTO cs_threads
      (reviewer_phone8,reviewer_name,campaign_key,campaign_label,campaign_source,status,admin_unread_count)
      VALUES($1,$2,$3,$4,'review_index','open',0)
      ON CONFLICT(reviewer_phone8,campaign_key) DO UPDATE SET status='open'
      RETURNING id,(xmax=0) AS "isNew"`,[phone8,owner.name || '리뷰어',campaignKey,context.displayName || '문의'])).rows[0];
    const meta = {purchaseCaptureCheck:{requestId:row.id,orderSubmissionId:context.order.id,channel,evidenceHash:hash,status:row.status}};
    const message = (await client.query(`INSERT INTO cs_messages
      (thread_id,sender_role,sender_name,content,msg_type,meta) VALUES($1,'reviewer',$2,$3,'text',$4::jsonb) RETURNING id`,
    [thread.id,owner.name || '리뷰어',content,JSON.stringify(meta)])).rows[0];
    await client.query(`UPDATE cs_threads SET admin_unread_count=admin_unread_count+1,
      last_message_at=now(),last_message_preview=$2,updated_at=now() WHERE id=$1`,[thread.id,content.slice(0,120)]);
    await client.query('UPDATE purchase_capture_check_requests SET cs_message_id=$2 WHERE id=$1',[row.id,message.id]);
    return {request:publicRequest(row),created:true,notification:{isNew:thread.isNew===true,threadId:thread.id,reviewerName:owner.name||'리뷰어',reviewerPhone8:phone8,campaignLabel:context.displayName||'문의',preview:content.slice(0,120)}};
  }
  async function requestCheck({session,orderSubmissionId,channel,expectedEvidenceHash,note}) {
    const out = await getCore().withOrderTransaction({session,orderSubmissionId},async(client,context)=>{
      if (evidence(context,channel) !== expectedEvidenceHash) throw fault(409,'STALE_EVIDENCE','사진이 바뀌었습니다. 새로고침 후 다시 확인해주세요.');
      const result = await requestInTx(client,{context,channel,note});
      return {...result,item:await getCore().viewInTx(client,context)};
    });
    if (out.created) { try { await notify(out); } catch (_) { /* Committed; never retry storage for notification failure. */ } }
    return out;
  }
  function staffActor(actor) {
    if (!actor || !['master','admin','staff'].includes(actor.role) ||
        actor.scope != null || actor.aud != null || actor.purpose != null || actor.via === 'reviewer_campaign') {
      throw fault(403,'STAFF_REQUIRED','내부 담당자만 사진을 확인할 수 있습니다.');
    }
  }
  function requestIdValue(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw fault(404,'CHECK_NOT_FOUND','확인 요청을 찾을 수 없습니다.');
    }
    return id;
  }
  async function staffTransaction({actor,requestId}, run) {
    staffActor(actor); // Must precede even the initial order lookup.
    const id = requestIdValue(requestId);
    const locator = (await db.query('SELECT order_submission_id FROM purchase_capture_check_requests WHERE id=$1',[id])).rows[0];
    if (!locator) throw fault(404,'CHECK_NOT_FOUND','확인 요청을 찾을 수 없습니다.');
    // Core always acquires lifecycle/order locks before the request row lock.
    return getCore().withOrderTransaction({actor,orderSubmissionId:locator.order_submission_id,forStaff:true},async(client,context)=>{
      const row=(await client.query('SELECT * FROM purchase_capture_check_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!row || row.order_submission_id !== context.order.id) throw fault(404,'CHECK_NOT_FOUND','확인 요청을 찾을 수 없습니다.');
      return run(client,context,row);
    });
  }
  async function getForStaff(args) {
    return staffTransaction(args,async(client,context,row)=>({request:publicRequest(row),item:await getCore().viewInTx(client,context)}));
  }
  async function decideForStaff({actor,requestId,decision,note,expectedEvidenceHash}) {
    staffActor(actor);
    const textNote=cleanNote(note);
    if (!['needs_photo','confirmed'].includes(decision) || (decision==='needs_photo' && !textNote)) {
      throw fault(400,'INVALID_DECISION','사진 보완 요청에는 사유를 입력해주세요.');
    }
    return staffTransaction({actor,requestId},async(client,context,row)=>{
      const hash=evidence(context,row.channel);
      if (hash !== row.evidence_hash || hash !== expectedEvidenceHash) throw fault(409,'STALE_EVIDENCE','사진이 바뀌었습니다. 새로고침 후 다시 확인해주세요.');
      if (row.status===decision && row.note===textNote) return {request:publicRequest(row),item:await getCore().viewInTx(client,context)};
      const original=(await client.query('SELECT thread_id FROM cs_messages WHERE id=$1',[row.cs_message_id])).rows[0];
      if (!original) throw fault(409,'CS_MESSAGE_UNAVAILABLE','원래 문의 메시지를 찾을 수 없습니다.');
      const meta={purchaseCaptureCheck:{requestId:row.id,orderSubmissionId:row.order_submission_id,channel:row.channel,evidenceHash:hash,status:decision}};
      const content=decision==='confirmed' ? '구매 사진 확인이 완료되었습니다.'+(textNote ? `\n${textNote}` : '') : `구매 사진 보완이 필요합니다.\n사유: ${textNote}`;
      await client.query('UPDATE cs_messages SET meta=meta || $2::jsonb WHERE id=$1',[row.cs_message_id,JSON.stringify(meta)]);
      const message=(await client.query(`INSERT INTO cs_messages
        (thread_id,sender_role,sender_name,content,msg_type,meta) VALUES($1,'admin','담당자',$2,'text',$3::jsonb) RETURNING id`,
      [original.thread_id,content,JSON.stringify(meta)])).rows[0];
      await client.query(`INSERT INTO purchase_capture_check_history(request_id,status,note,actor,cs_message_id)
        VALUES($1,$2,$3,$4::jsonb,$5)`,[row.id,decision,textNote,JSON.stringify({...(actor.id != null ? {id:actor.id} : {}),role:actor.role,name:String(actor.name || '')}),message.id]);
      const updated=(await client.query(`UPDATE purchase_capture_check_requests SET status=$2,note=$3,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,decision,textNote])).rows[0];
      await client.query(`UPDATE cs_threads SET reviewer_unread_count=reviewer_unread_count+1,
        status='open',last_message_at=now(),last_message_preview=$2,updated_at=now() WHERE id=$1`,[original.thread_id,content.slice(0,120)]);
      return {request:publicRequest(updated),item:await getCore().viewInTx(client,context)};
    });
  }
  return {requestInTx,requestCheck,getForStaff,decideForStaff};
}

let production;
function productionService() {
  return production || (production = createService({db:require('../db/pool')}));
}
module.exports = {createService,notifyCreated};
for (const name of ['requestCheck','requestInTx','getForStaff','decideForStaff']) module.exports[name] = (...args)=>productionService()[name](...args);
