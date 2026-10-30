'use strict';
// Operator-only restoration; no HTTP route, transfer generator or notification.
const crypto = require('crypto');
const { digitsOnly } = require('../utils/paymentResultParse');
const { normName } = require('./identity.service');
function fail(code) { const e = new Error(`Historical fee restore refused: ${code}`); e.code = code; throw e; }
function one(list, predicate, code) { const found = list.filter(predicate); if (found.length !== 1) fail(code); return found[0]; }
function validateCandidates(m, state, results) {
  if (!m || !Number.isSafeInteger(m.expectedCount) || m.expectedCount < 1 || m.fee !== 1000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(m.paidDate || '') || !Array.isArray(m.rows) || m.rows.length !== m.expectedCount) fail('scope_invalid');
  for (const key of ['participantId','orderId','resultSeq','memoEditId']) {
    if (new Set(m.rows.map(r=>r[key])).size !== m.expectedCount || m.rows.some(r=>r[key] == null)) fail('duplicate_anchor');
  }
  return m.rows.map(anchor => {
    const p = one(state.participants, x=>String(x.id)===String(anchor.participantId),'participant_missing');
    if (p.sheet_id!==m.sheetId || p.tab_name!==m.tabName || !p.active || p.deleted_at || !p.owner_reviewer_id ||
        String(p.owner_reviewer_id)!==String(anchor.ownerId) || p.order_submission_id!==anchor.orderId) fail('participant_drift');
    one(state.participants, x=>x.active && !x.deleted_at && x.order_submission_id===anchor.orderId,'order_not_unique');
    const o = one(state.orders, x=>x.id===anchor.orderId,'order_missing');
    if (o.deleted_at || o.owner_reviewer_id!==p.owner_reviewer_id ||
        o.participant_identity_id!==p.participant_identity_id || normName(o.orderer)!==normName(p.reviewer_name) ||
        digitsOnly(o.phone).slice(-8)!==p.phone8 || !Object.hasOwn(anchor,'reviewFeeSnapshot') ||
        o.review_fee_snapshot!==anchor.reviewFeeSnapshot) fail('order_drift');
    const ri = one(state.index, x=>x.sheet_id===m.sheetId && x.tab_name===m.tabName && x.row_index===p.seq,'index_missing');
    if (ri.reviewer_name!==p.reviewer_name || ri.phone8!==p.phone8) fail('index_owner_drift');
    const e = one(state.edits,x=>String(x.id)===String(anchor.memoEditId),'memo_missing');
    if (e.sheet_id!==m.sheetId || e.tab_name!==m.tabName || e.anchor_type!=='order' || e.anchor_value!==o.id ||
        e.field!=='col:비고' || e.reverted_at || !e.created_by || e.created_by.startsWith('업체#') ||
        !/10\/27.*입금완료/.test(e.value_text || '')) fail('staff_evidence_drift');
    const r = one(results,x=>Number(x.seq)===Number(anchor.resultSeq),'result_missing');
    if (!r.success || Number(r.amount)!==m.fee || !digitsOnly(o.account) || digitsOnly(o.account)!==r.accountDigits ||
        !normName(o.depositor) || normName(o.depositor)!==normName(r.holder)) fail('result_mismatch');
    one(results,x=>x.success && Number(x.amount)===m.fee && x.accountDigits===digitsOnly(o.account) &&
        normName(x.holder)===normName(o.depositor),'result_not_unique');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(r.transferredAtIso || '') ||
        r.transferredAtIso.slice(0,10)!==m.paidDate || r.transferredAtIso!==anchor.paidAt ||
        !Number.isFinite(Date.parse(r.transferredAtIso))) fail('result_time_drift');
    return { anchor,p,o,ri,e,result:r };
  });
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return {sha256:crypto.createHash('sha256').update(value).digest('hex')};
  if (Array.isArray(value)) return value.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
async function loadState(db, m, { lock = false } = {}) {
  const scope = [m.sheetId, m.preserveSheetId], out = {};
  const spec = {
    participants:['campaign_participants','sheet_id = ANY($1::text[])',[scope]],
    orders:['order_submissions','id IN (SELECT order_submission_id FROM campaign_participants WHERE sheet_id = ANY($1::text[]))',[scope]],
    index:['review_index','sheet_id = ANY($1::text[])',[scope]],
    edits:['participant_edits','sheet_id = ANY($1::text[])',[scope]],
    tabs:['tab_configs','sheet_id = ANY($1::text[])',[scope]],
    campaigns:['recruit_campaigns','linked_sheet_id = ANY($1::text[])',[scope]],
    items:['payment_batch_items','sheet_id = ANY($1::text[])',[scope]],
    records:['payment_records','sheet_id = ANY($1::text[]) OR source_key LIKE $2',[scope,`historical-fee:${m.fileSha256}:%`]],
    sourceBatch:['payment_batches','id = $1',[m.sourceBatchId]],
    sourceItems:['payment_batch_items','batch_id = $1',[m.sourceBatchId]],
    competingItems:['payment_batch_items',`amount = $2 AND (status = 'pending' OR (status = 'paid' AND paid_at BETWEEN $3::timestamptz - INTERVAL '5 minutes' AND $4::timestamptz + INTERVAL '5 minutes'))
      AND REGEXP_REPLACE(bank_account,'[^0-9]','','g') IN
       (SELECT REGEXP_REPLACE(o.account,'[^0-9]','','g') FROM order_submissions o JOIN campaign_participants p ON p.order_submission_id=o.id WHERE p.id::text = ANY($1::text[]))`,
       [m.rows.map(r=>r.participantId),m.fee,m.rows.map(r=>r.paidAt).sort()[0],m.rows.map(r=>r.paidAt).sort().slice(-1)[0]]],
    uploads:['payment_result_uploads','id = $1 OR file_sha256 = $2',[m.uploadId,m.fileSha256]],
    reviews:['unconfirmed_transfer_reviews','upload_id IN (SELECT id FROM payment_result_uploads WHERE id = $1 OR file_sha256 = $2)',[m.uploadId,m.fileSha256]],
    accountReconciliations:['payment_account_mismatch_reconciliations','upload_id IN (SELECT id FROM payment_result_uploads WHERE id = $1 OR file_sha256 = $2)',[m.uploadId,m.fileSha256]],
    amountReconciliations:['payment_amount_mismatch_reconciliations','upload_id IN (SELECT id FROM payment_result_uploads WHERE id = $1 OR file_sha256 = $2)',[m.uploadId,m.fileSha256]],
    manualMarks:['manual_payment_marks','sheet_id = ANY($1::text[])',[scope]],
    checks:['ops_checks','id = $1',[m.checkId]],
    bank:['payment_bank_rows',"bank = $1 AND traded_at >= $2::timestamptz AND traded_at < $2::timestamptz + INTERVAL '1 day'",['kbank',m.paidDate+'T00:00:00+09:00']],
    sync:['payment_bank_sync','TRUE',[]],
    history:['payment_batches','historical_key = $1',[historyKey(m)]],
  };
  for (const [key,[table,where,args]] of Object.entries(spec)) out[key]=(await db.query(`SELECT * FROM ${table} WHERE ${where}${lock ? (['participants','orders','index','edits'].includes(key) ? ' FOR UPDATE' : ' FOR SHARE') : ''}`,args)).rows;
  return out;
}
function historyKey(m) { return `historical-fee:${m.fileSha256}:${m.sheetId}`; }
function sourceKey(m,seq) { return `historical-fee:${m.fileSha256}:${seq}`; }
function dateIso(value) { return new Date(value).toISOString(); }
function checkComplete(m, state, candidates) {
  if (!state.history.length) return null;
  const b=one(state.history,()=>true,'partial_history'), items=state.items.filter(i=>i.batch_id===b.id);
  if (b.status!=='applied' || b.bank!=='kbank' || Number(b.download_count)!==0 || b.last_downloaded_at || b.last_downloaded_by ||
      Number(b.item_count)!==m.expectedCount || Number(b.total_amount)!==m.fee*m.expectedCount || items.length!==m.expectedCount) fail('partial_history');
  const ownRecords=state.records.filter(r=>String(r.source_key || '').startsWith(`historical-fee:${m.fileSha256}:`));
  const ownReviews=state.reviews.filter(r=> { try {return JSON.parse(r.review_note).historicalKey===historyKey(m);}catch{return false;} });
  if(ownRecords.length!==m.expectedCount || ownReviews.length!==m.expectedCount || state.competingItems.some(i=>i.batch_id!==b.id)) fail('partial_history');
  for(const c of candidates) {
    if(state.records.some(r=>r.sheet_id===m.sheetId && r.tab_name===m.tabName && r.row_index===c.p.seq && r.source_key!==sourceKey(m,c.result.seq)) ||
        state.items.some(i=>i.sheet_id===m.sheetId && i.tab_name===m.tabName && i.row_index===c.p.seq && i.batch_id!==b.id)) fail('partial_history');
    const it=one(items,i=>i.result_seq===c.result.seq,'partial_item');
    if(it.sheet_id!==m.sheetId || it.tab_name!==m.tabName || it.row_index!==c.p.seq || it.phone8!==c.p.phone8 ||
        it.reviewer_name!==c.p.reviewer_name || it.owner_reviewer_id!==c.p.owner_reviewer_id ||
        it.participant_identity_id!==c.p.participant_identity_id || it.status!=='paid' || Number(it.product_price)!==0 ||
        Number(it.review_fee)!==m.fee || Number(it.amount)!==m.fee || dateIso(it.paid_at)!==dateIso(c.result.transferredAtIso) ||
        digitsOnly(it.bank_account)!==c.result.accountDigits || it.account_holder!==c.o.depositor || it.account_source!==null) fail('partial_item');
    const rec=one(ownRecords,r=>r.source_key===sourceKey(m,c.result.seq),'partial_record');
    if(rec.sheet_id!==m.sheetId || rec.tab_name!==m.tabName || rec.row_index!==c.p.seq || rec.reviewer_name!==c.p.reviewer_name ||
        Number(rec.amount)!==m.fee || dateIso(rec.paid_at)!==dateIso(c.result.transferredAtIso)) fail('partial_record');
    const rev=one(ownReviews,r=>r.upload_id===m.uploadId && r.result_seq===c.result.seq,'partial_reservation'), note=JSON.parse(rev.review_note);
    if(rev.batch_id!==m.sourceBatchId || rev.sheet_id!==m.sheetId || rev.tab_name!==m.tabName || rev.participant_row_index!==c.p.seq ||
        rev.decision!=='APPROVED' || note.participantId!==c.p.id || note.orderId!==c.o.id || note.itemId!==it.id || note.sourceKey!==rec.source_key) fail('partial_reservation');
  }
  return {batchId:b.id,inserted:0,skipped:m.expectedCount,total:m.fee*m.expectedCount};
}
function protectedState(m,state) {
  const out={...state};delete out.history;
  const ids=new Set(state.history.map(b=>b.id));
  out.items=state.items.filter(i=>!ids.has(i.batch_id));
  out.competingItems=state.competingItems.filter(i=>!ids.has(i.batch_id));
  out.records=state.records.filter(r=>!String(r.source_key || '').startsWith(`historical-fee:${m.fileSha256}:`));
  out.reviews=state.reviews.filter(r=> {try{return JSON.parse(r.review_note).historicalKey!==historyKey(m);}catch{return true;} });
  return out;
}
async function restoreHistoricalFees({ db, manifest:m, apply=false, expectedBeforeHash, backup, by, proof, fingerprints }) {
  if (!db || !m || !/^[a-f0-9]{64}$/.test(m.fileSha256 || '') || !m.uploadId || !m.sourceBatchId || !m.preserveSheetId ||
      m.preserveSheetId===m.sheetId || !Number.isSafeInteger(m.checkId) || !by) fail('manifest_invalid');
  const guard=proof || require('./paymentProof.service'), c=await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await c.query("SET LOCAL lock_timeout = '5s'");
    await c.query("SET LOCAL statement_timeout = '30s'");
    const evidence=await guard.lockUploadProof(c,{uploadId:m.uploadId,batchId:m.sourceBatchId});
    if(evidence.sha!==m.fileSha256) fail('file_hash_drift');
    await guard.lockFileProof(c,evidence.sha);
    const {rows:[source]}=await c.query(`SELECT * FROM payment_batches WHERE id = $1${apply ? ' FOR UPDATE' : ''}`,[m.sourceBatchId]);
    if(!source || source.bank!=='kbank' || source.status==='cancelled' || source.historical_key) fail('source_batch_drift');
    // Source-batch lookup above reads no participants. Hold the deletion barrier
    // before loadState reads/locks ANY target, in dry-run as well as apply.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',[m.sheetId,m.tabName]);
    const state=await loadState(c,m,{lock:apply}), u=one(state.uploads,x=>x.id===m.uploadId,'source_upload_missing'), buffer=Buffer.from(u.file_blob || []);
    if(!buffer.length || crypto.createHash('sha256').update(buffer).digest('hex')!==m.fileSha256 || u.batch_id!==m.sourceBatchId || u.bank!=='kbank') fail('file_hash_drift');
    const loaded=require('../utils/spreadsheetLoad').loadSheetAoa(buffer,u.file_name);
    if(!loaded.ok) fail('file_parse_failed');
    const parsed=require('../utils/paymentResultParse').parseResultAoa(loaded.aoa,{expectBank:'kbank'});
    if(!parsed.ok || parsed.rows.length!==m.expectedFileRows || parsed.rows.filter(r=>r.success).length!==m.expectedFileRows) fail('file_parse_drift');
    const candidates=validateCandidates(m,state,parsed.rows), complete=checkComplete(m,state,candidates);
    if(complete) { await c.query('ROLLBACK');return {...complete,dryRun:!apply}; }
    if(state.competingItems.length) fail('competing_payment');
    for(const x of candidates) {
      if(state.items.some(i=>i.sheet_id===m.sheetId && i.tab_name===m.tabName && i.row_index===x.p.seq) ||
          state.records.some(r=>r.sheet_id===m.sheetId && r.tab_name===m.tabName && r.row_index===x.p.seq) ||
          state.manualMarks.some(r=>r.sheet_id===m.sheetId && r.tab_name===m.tabName && r.row_index===x.p.seq)) fail('competing_payment');
      await guard.assertProofUnused(c,{...evidence,resultSeq:x.result.seq});
    }
    const beforeHash=digest(state), invariantHash=digest(protectedState(m,state));
    const result={dryRun:!apply,inserted:apply ? m.expectedCount : 0,planned:m.expectedCount,skipped:0,total:m.fee*m.expectedCount,beforeHash,invariantHash};
    if(!apply) { await c.query('ROLLBACK');return result; }
    if(!expectedBeforeHash || beforeHash!==expectedBeforeHash) fail('before_state_drift');
    if(typeof backup!=='function') fail('backup_required');
    const saved=await backup({manifest:m,manifestHash:digest(m),beforeHash,invariantHash,state});
    if(!saved || saved.beforeHash!==beforeHash || !saved.path) fail('backup_unconfirmed');
    const {rows:[batch]}=await c.query(`INSERT INTO payment_batches
      (bank,status,item_count,total_amount,created_by,download_count,last_downloaded_at,last_downloaded_by,historical_key,applied_at,applied_by,
       board_recorded_count,board_queued_count,board_skipped_count,board_failed_count,board_stamp,board_recorded_at,board_recorded_by)
      VALUES ('kbank','applied',$1,$2,$3,0,NULL,NULL,$4,NOW(),$3,$1,0,0,0,$5,NOW(),$3) RETURNING *`,
      [m.expectedCount,m.fee*m.expectedCount,by,historyKey(m),`${Number(m.paidDate.slice(5,7))}/${Number(m.paidDate.slice(8,10))}`]);
    if(!batch) fail('batch_insert_failed');
    const fp=fingerprints || require('./payment.service');
    for(const x of candidates) {
      const bank=require('../utils/bankCodes').resolveBank(x.o.bank);
      if(!bank) fail('bank_code_unknown');
      const id=crypto.randomUUID();
      await c.query(`INSERT INTO payment_batch_items
        (id,batch_id,sheet_id,tab_name,row_index,reviewer_name,phone8,bank_name,bank_code,bank_account,account_holder,
         product_price,review_fee,amount,transfer_memo,status,paid_at,result_status,result_seq,owner_reviewer_id,participant_identity_id,
         account_source,account_fingerprint,account_snapshot_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$12,$13,'paid',$14,$15,$16,$17,$18,NULL,$19,$20)`,
        [id,batch.id,m.sheetId,m.tabName,x.p.seq,x.p.reviewer_name,x.p.phone8,x.o.bank,bank.code || bank,x.result.accountDigits,x.o.depositor,
         m.fee,x.result.memo,x.result.transferredAtIso,x.result.statusRaw,x.result.seq,x.p.owner_reviewer_id,x.p.participant_identity_id,
         fp.accountFingerprint(x.result.accountDigits),fp.snapshotFingerprint(x.o.bank,x.result.accountDigits,x.o.depositor)]);
      const key=sourceKey(m,x.result.seq), note=JSON.stringify({historicalKey:historyKey(m),purpose:'historical review fee only / no resend',fileSha256:m.fileSha256,
        sourceKey:key,participantId:x.p.id,orderId:x.o.id,ownerId:x.p.owner_reviewer_id,itemId:id,accountProvenance:'historical ORDER',paidAt:x.result.transferredAtIso});
      await c.query(`INSERT INTO unconfirmed_transfer_reviews
        (batch_id,upload_id,result_seq,memo,sheet_id,tab_name,participant_row_index,decision,review_note,reviewed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'APPROVED',$8,$9)`,
        [m.sourceBatchId,m.uploadId,x.result.seq,x.result.memo,m.sheetId,m.tabName,x.p.seq,note,by]);
      const count=await require('./paymentApply.service').recordDeposits(c,[{sheetId:m.sheetId,tabName:m.tabName,rowIndex:x.p.seq,
        reviewerName:x.p.reviewer_name,amount:String(m.fee),feeOnly:true,paidAt:x.result.transferredAtIso,sourceKey:key}],{by});
      if(count!==1) fail('ledger_insert_failed');
    }
    const after=await loadState(c,m), done=checkComplete(m,after,candidates);
    if(!done || digest(protectedState(m,after))!==invariantHash) fail('protected_state_changed');
    await c.query('COMMIT');
    return {...result,batchId:batch.id,backupPath:saved.path};
  } catch(e) { try {await c.query('ROLLBACK');}catch {} throw e; }
  finally { c.release(); }
}
module.exports = { validateCandidates, canonical, digest, historyKey, sourceKey, loadState, checkComplete, protectedState, restoreHistoricalFees };
