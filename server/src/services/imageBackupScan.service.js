'use strict';
const crypto=require('node:crypto');
const backup=require('./imageBackup.service');
const FOLDER='application/vnd.google-apps.folder';
// Exact native document types only; shortcuts, unknown Google types and binary
// non-images remain unresolved/blocked. These have no downloadable image bytes.
const NATIVE_DOCUMENTS=new Set(['document','spreadsheet','presentation','drawing','form','script','site'].map(t=>'application/vnd.google-apps.'+t));
function fail(code){return Object.assign(new Error(code),{code});}
function config(env=process.env){
 const allowed=JSON.parse(env.IMAGE_BACKUP_ALLOWED_ROOT_IDS||'[]'),excluded=JSON.parse(env.IMAGE_BACKUP_EXCLUDED_ROOT_IDS||'[]');
 const roots=JSON.parse(env.IMAGE_BACKUP_ROOT_READERS||'[]');
 if(!Array.isArray(allowed)||!allowed.length||!Array.isArray(excluded)||!Array.isArray(roots)||roots.length!==allowed.length)throw fail('BACKUP_CONFIG_INVALID');
 const ids=new Set();for(const r of roots){if(!/^[A-Za-z0-9_-]{10,200}$/.test(r.rootId)||ids.has(r.rootId)||!allowed.includes(r.rootId)||excluded.includes(r.rootId)||!Array.isArray(r.readerKinds)||!r.readerKinds.length||new Set(r.readerKinds).size!==r.readerKinds.length||r.readerKinds.some(k=>!['sa','oauth'].includes(k)))throw fail('BACKUP_CONFIG_INVALID');ids.add(r.rootId);}
 if([...allowed,...excluded].some(x=>!/^[A-Za-z0-9_-]{10,200}$/.test(x)))throw fail('BACKUP_CONFIG_INVALID');
 return {roots,excluded};
}
async function dependencies(deps={}){
 const cfg=deps.roots?{roots:deps.roots,excluded:deps.excluded||[]}:config();
 return {...cfg,pool:deps.pool||require('../db/imageBackupPool').getPool(),readers:deps.readers||require('./drive.service').getBackupReadClients(),api:deps.api||require('./imageBackupClient.service').createClient(),loadHints:deps.loadHints||loadHints,...deps};
}
async function loadHints({fileId,pool}){
 // Mandatory transfer exclusion is NOT fail-open. These are actual migration columns.
 const transfer=await pool.query('SELECT drive_file_id FROM payment_result_drive_archive WHERE drive_file_id=$1',[fileId]);
 const hints=[];let source;
 try{
 const reviews=await pool.query('SELECT s.slot_key,s.evidence_role,t.capture_slots,t.income_type FROM review_submissions s LEFT JOIN tab_configs t ON t.sheet_id=s.sheet_id AND t.tab_name=s.tab_name WHERE s.file_id=$1',[fileId]);
 const edits=await pool.query('SELECT r.slot_key,r.status,t.capture_slots,t.income_type FROM review_edit_requests r LEFT JOIN tab_configs t ON t.sheet_id=r.sheet_id AND t.tab_name=r.tab_name WHERE r.new_file_id=$1 OR r.old_file_id=$1',[fileId]);
 const guides=await pool.query('SELECT source FROM guide_image_files WHERE file_id=$1',[fileId]);
 const {isCashReceiptSlot}=require('../utils/captureSlots');
 if(reviews.rows.some(r=>r.evidence_role==='receipt'||isCashReceiptSlot(r.capture_slots,r.income_type,r.slot_key)))hints.push('receipt');
 if(edits.rows.some(r=>r.status==='pending'||isCashReceiptSlot(r.capture_slots,r.income_type,r.slot_key)))hints.push('pending');
 if(guides.rows.some(r=>r.source.includes('cs')))hints.push('cs');
 if(guides.rows.some(r=>/^upload:(order|intranet)$/.test(r.source)))source='guide';
 }catch(_){hints.push('unknown');}
 return {transferIds:new Set(transfer.rows.map(r=>r.drive_file_id)),privateHints:hints,source};
}
async function resolveActualPath({fileId,rootId,reader,cache=new Map()}){
 async function get(id){if(!cache.has(id)){const m=await reader.getMetadata(id);if(!m||m.id!==id||m.trashed)throw fail('SOURCE_CHANGED');cache.set(id,m);}return cache.get(id);}
 const metadata=await get(fileId);const chain=[];let m=metadata;const seen=new Set([fileId]);
 if(fileId===rootId)return {chain:[{id:rootId,name:metadata.name}],metadata};
 for(let depth=0;depth<100;depth++){
 if(!Array.isArray(m.parents)||m.parents.length!==1)throw fail('UNRESOLVED_PATH');
 const id=m.parents[0];if(seen.has(id))throw fail('UNRESOLVED_PATH');seen.add(id);m=await get(id);
 if(m.mimeType!==FOLDER)throw fail('UNRESOLVED_PATH');chain.unshift({id:m.id,name:m.name});
 if(id===rootId)return {chain,metadata};
 }
 throw fail('UNRESOLVED_PATH');
}
async function classifyScope({chain=[],source,fileId,privateHints=[],transferIds,excludedRootIds=[]}){
 if(source==='payment_result'||transferIds?.has(fileId)||chain.some(p=>excludedRootIds.includes(p.id)))return {decision:'exclude',section:'internal',reason:'payment_result'};
 if(!transferIds)return {decision:'retry',section:'internal',reason:'EXCLUSION_UNAVAILABLE'};
 if(privateHints.length||chain.some(p=>/현금영수증|문의첨부|리뷰수정대기|리뷰교체보관/.test(p.name)))return {decision:'include',section:'internal',reason:'private'};
 if(source==='guide'||chain.some(p=>p.name==='[유입가이드]'))return {decision:'include',section:'common',reason:'guide'};
 if(chain.some(p=>['[리뷰]','[구매캡처]'].includes(p.name)))return {decision:'include',section:'work',reason:'actual_work_path'};
 return {decision:'include',section:'internal',reason:'unclassified'};
}
async function observe({fileId,rootId,reader,source,deps,cache}){
 const {chain,metadata}=await resolveActualPath({fileId,rootId,reader,cache});
 const hints=await deps.loadHints({fileId,pool:deps.pool});
 const scope=await classifyScope({chain,fileId,...hints,source:source==='payment_result'?source:(hints.source||source),excludedRootIds:deps.excluded});
 if(scope.decision!=='include')return {scope,metadata};
 if(NATIVE_DOCUMENTS.has(metadata.mimeType))return {scope:{decision:'exclude',section:scope.section,reason:'NATIVE_DOCUMENT_EXCLUDED'},metadata};
 const size=Number(metadata.size);if(!Number.isSafeInteger(size)||size<0)throw fail('UNRESOLVED_SIZE');
 if(!/^image\//.test(metadata.mimeType||''))throw fail('UNSUPPORTED_MIME');
 const descriptor={fileId,rootId,chain,name:metadata.name,mime:metadata.mimeType.toLowerCase(),size,sourceVersion:String(metadata.version||'') ,section:scope.section};
 if(!descriptor.sourceVersion)throw fail('UNRESOLVED_VERSION');
 const observation={descriptor,modifiedTime:metadata.modifiedTime||null,md5Checksum:metadata.md5Checksum||null,readerKind:reader.kind};
 const jobKey='obs:'+backup.sha(backup.canonical({descriptor,modifiedTime:observation.modifiedTime,md5Checksum:observation.md5Checksum}));
 return {scope,metadata,observation,jobKey};
}
// 결정 368: a live service keeps moving/replacing photos during a multi-hour scan.
// A file seen again with a different observation (or whose job was superseded) is
// re-read LIVE from every approved root; only that file is updated/re-enqueued.
// Earlier jobs/copies are never removed. Unknowable or endlessly changing files
// become 'unresolved' alone, and the scan ends incomplete without publishing.
const MAX_FILE_REVISITS=5;
const plain=d=>{if(!d||typeof d!=='object')return d;const {readerKind,scanRevisits,...rest}=d;return rest;};
const notHere=e=>['UNRESOLVED_PATH','SOURCE_CHANGED'].includes(e.code)||e.code===404||e.response?.status===404;
async function observeLive({fileId,deps:d}){
 const found=new Map();
 for(const root of d.roots)for(const kind of root.readerKinds){
  const reader=d.readers.find(r=>r.kind===kind);if(!reader)throw fail('READER_UNAVAILABLE');let o;
  try{o=await observe({fileId,rootId:root.rootId,reader,deps:d,cache:new Map()});}catch(e){if(notHere(e))continue;throw e;}
  if(o.scope.decision==='retry')throw fail(o.scope.reason);
  const k=o.jobKey||'excluded:'+o.scope.reason;if(!found.has(k))found.set(k,o.jobKey?{data:o.observation,jobKey:o.jobKey,state:'pending'}:{data:{fileId,reason:o.scope.reason},jobKey:null,state:'excluded'});
 }
 if(found.size===1)return [...found.values()][0];
 // Not visible under any approved root/reader (definitive 404 / outside scope, never a network error —
 // those throw above) = deleted or moved out of scope. Earlier copies stay (2A); excluded and counted.
 if(!found.size)return {data:{fileId,reason:'SOURCE_GONE'},jobKey:null,state:'excluded'};
 return {data:{fileId,reason:'AMBIGUOUS_ROOT'},jobKey:null,state:'unresolved'};
}
async function revisit(c,{scanId,key,old,live}){
 const fileId=key.slice(5),revisits=(Number(old.data?.scanRevisits)||0)+1;
 const next=live.state!=='unresolved'&&revisits>MAX_FILE_REVISITS?{data:{fileId,reason:'SOURCE_UNSTABLE'},jobKey:null,state:'unresolved'}:live;
 if(next.jobKey){await backup.enqueue({...next.data,fileId:next.data.descriptor.fileId,jobKey:next.jobKey},{pool:c});
  // Live state returned to an earlier observation (A→B→A): its row may already be terminal 'superseded'
  // (enqueue is ON CONFLICT DO NOTHING). Make exactly that row runnable again; done rows stay done.
  await c.query("UPDATE image_backup_outbox SET status='pending',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE job_key=$1 AND status='superseded'",[next.jobKey]);}
 await c.query('UPDATE image_backup_scan_entries SET data=$3,job_key=$4,state=$5 WHERE scan_id=$1 AND entry_key=$2',[scanId,key,JSON.stringify({...next.data,scanRevisits:revisits}),next.jobKey,next.state]);
 if(next.state==='excluded'&&next.data.reason==='SOURCE_GONE')await c.query("UPDATE image_backup_scans SET counts=jsonb_set(counts,'{excludedSourceGone}',to_jsonb(COALESCE((counts->>'excludedSourceGone')::int,0)+1)) WHERE id=$1",[scanId]);
}
async function transaction(pool,fn){const c=pool.connect?await pool.connect():pool;try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{if(c!==pool)c.release();}}
async function startScan({deps={}}={}){
 const d=await dependencies(deps);if(!(await backup.checkBackupSchema({pool:d.pool})).ready)throw fail('BACKUP_SCHEMA_UNAVAILABLE');
 const active=await d.pool.query("SELECT * FROM image_backup_scans WHERE state IN ('running','incomplete','publishing') LIMIT 1");if(active.rows.length)return active.rows[0];
 for(const root of d.roots)for(const kind of root.readerKinds){const reader=d.readers.find(r=>r.kind===kind);if(!reader)throw fail('READER_UNAVAILABLE');const m=await reader.getMetadata(root.rootId);if(m?.id!==root.rootId||m.mimeType!==FOLDER||m.trashed)throw fail('UNRESOLVED_ROOT');}
 const current=await d.api.readCurrent();let max=BigInt(current?.generation||'0'),cursor=null;const seen=new Set();
 do{const page=await d.api.listManifests({kind:'generations',cursor,limit:1000});for(const i of page.items){const match=/^manifests\/([1-9][0-9]*)\//.exec(i.key);if(match&&BigInt(match[1])>max)max=BigInt(match[1]);}if(page.truncated&&(!page.cursor||seen.has(page.cursor)))throw fail('BAD_CURSOR');cursor=page.truncated?page.cursor:null;if(cursor)seen.add(cursor);}while(cursor);
 // Sequence never goes backwards, including after DB recreation.
 return transaction(d.pool,async c=>{
 await c.query("LOCK TABLE image_backup_scans IN EXCLUSIVE MODE");
 const a=await c.query("SELECT * FROM image_backup_scans WHERE state IN ('running','incomplete','publishing') LIMIT 1");if(a.rows.length)return a.rows[0];
 await c.query("SELECT setval(pg_get_serial_sequence('image_backup_scans','id'),GREATEST($1::bigint,COALESCE((SELECT max(id) FROM image_backup_scans),0),1),true)",[max.toString()]);
 const r=await c.query('INSERT INTO image_backup_scans(root_set_hash,roots,base_generation,base_etag) VALUES($1,$2,$3,$4) RETURNING *',[backup.sha(backup.canonical(d.roots)),JSON.stringify(d.roots),current?.generation||null,current?.etag||null]);const scan=r.rows[0];
 for(const root of d.roots)for(const kind of root.readerKinds){if(!d.readers.find(r=>r.kind===kind))throw fail('READER_UNAVAILABLE');await c.query("INSERT INTO image_backup_scan_entries(scan_id,entry_key,kind,data) VALUES($1,$2,'folder',$3)",[scan.id,`folder:${root.rootId}:${kind}:${root.rootId}`,JSON.stringify({rootId:root.rootId,readerKind:kind,folderId:root.rootId,pageToken:null,metadata:null})]);}
 return scan;
 });
}
async function scanStep({scanId,budgetMs=10000,deps={}}={}){
 const d=await dependencies(deps);const token=crypto.randomUUID();const now=d.now||Date.now;const start=now();const caches=new Map();
 const withinBudget=()=>now()-start<Math.min(budgetMs,60000);
 const got=await d.pool.query(`UPDATE image_backup_scans SET lease_token=$2,lease_until=now()+interval '120 seconds',state='running'
 WHERE id=$1 AND state IN ('running','incomplete','publishing') AND (lease_until IS NULL OR lease_until<=now()) RETURNING *`,[scanId,token]);
 if(!got.rows.length)return {state:'incomplete',cursor:{scanId,reason:'LEASE_BUSY'}};const scan=got.rows[0];
 if(backup.sha(backup.canonical(d.roots))!==scan.root_set_hash){await d.pool.query("UPDATE image_backup_scans SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",[scanId,token]);return {state:'incomplete',cursor:{scanId,reason:'ROOT_SET_CHANGED'}};}
 const owned=async c=>{const r=await c.query('SELECT id FROM image_backup_scans WHERE id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',[scanId,token]);if(!r.rows.length)throw fail('LEASE_LOST');};
 try{
 while(withinBudget()){
 const entry=(await d.pool.query("SELECT * FROM image_backup_scan_entries WHERE scan_id=$1 AND kind='folder' AND state='pending' ORDER BY entry_key LIMIT 1",[scanId])).rows[0];if(!entry)break;
 let data=entry.data;const reader=d.readers.find(r=>r.kind===data.readerKind);if(!reader)throw fail('READER_UNAVAILABLE');
 const cacheKey=data.rootId+':'+reader.kind;if(!caches.has(cacheKey))caches.set(cacheKey,new Map());const cache=caches.get(cacheKey);
 // Persist a bounded page BEFORE its expensive per-file metadata/hint work.
 // Offset and outbox reservation commit together: restart never repeats a whole slow page.
 if(!data.page){
  let page;try{page=await reader.listChildren(data.folderId,data.pageToken);}catch(e){if(e.code===400||e.response?.status===400)await d.pool.query("UPDATE image_backup_scan_entries SET data=jsonb_set(data,'{pageToken}','null') WHERE scan_id=$1 AND entry_key=$2 AND EXISTS(SELECT 1 FROM image_backup_scans WHERE id=$1 AND lease_token=$3 AND lease_until>now())",[scanId,entry.entry_key,token]);throw e;}
  if(!Array.isArray(page.files)||page.incompleteSearch||page.nextPageToken===data.pageToken&&data.pageToken)throw fail('INCOMPLETE_SEARCH');
  data={...data,page:{files:page.files,nextPageToken:page.nextPageToken||null,offset:0}};
  await transaction(d.pool,async c=>{await owned(c);await c.query('UPDATE image_backup_scan_entries SET data=$3 WHERE scan_id=$1 AND entry_key=$2',[scanId,entry.entry_key,JSON.stringify(data)]);});
 }
 for(const m of data.page.files)cache.set(m.id,m);
 while(data.page.offset<data.page.files.length&&withinBudget()){
  const m=data.page.files[data.page.offset];let r;
  if(!m.trashed){
   if(m.mimeType===FOLDER){if(!d.excluded.includes(m.id))r={key:`folder:${data.rootId}:${reader.kind}:${m.id}`,kind:'folder',data:{rootId:data.rootId,readerKind:reader.kind,folderId:m.id,pageToken:null,metadata:m},state:'pending'};}
   else{const o=await observe({fileId:m.id,rootId:data.rootId,reader,deps:d,cache});if(o.scope.decision==='retry')throw fail(o.scope.reason);r={key:'file:'+m.id,kind:'file',data:o.observation||{fileId:m.id,reason:o.scope.reason},state:o.scope.decision==='exclude'?'excluded':'pending',jobKey:o.jobKey};}
  }
  const next={...data,page:{...data.page,offset:data.page.offset+1}};
  // Same file seen again differently (moved/renamed/replaced mid-scan): follow the live state.
  let old,live,keep=false;
  if(r?.kind==='file'){old=(await d.pool.query('SELECT data,job_key,state FROM image_backup_scan_entries WHERE scan_id=$1 AND entry_key=$2',[scanId,r.key])).rows[0];
   if(old&&backup.canonical(plain(old.data))!==backup.canonical(plain(r.data))){if(old.state==='unresolved')keep=true;else{live=await observeLive({fileId:m.id,deps:d});if(live.state===old.state&&backup.canonical(plain(live.data))===backup.canonical(plain(old.data)))keep=true;}}}
  await transaction(d.pool,async c=>{await owned(c);
   if(live&&!keep)await revisit(c,{scanId,key:r.key,old,live});
   else if(r&&!keep){old=(await c.query('SELECT data,job_key FROM image_backup_scan_entries WHERE scan_id=$1 AND entry_key=$2',[scanId,r.key])).rows[0];
    if(r.jobKey)await backup.enqueue({...r.data,fileId:r.data.descriptor.fileId,jobKey:r.jobKey},{pool:c});
    await c.query('INSERT INTO image_backup_scan_entries(scan_id,entry_key,kind,data,job_key,state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[scanId,r.key,r.kind,JSON.stringify(r.data),r.jobKey||null,r.state]);
    if(!old&&r.state==='excluded'&&r.data.reason==='NATIVE_DOCUMENT_EXCLUDED')await c.query("UPDATE image_backup_scans SET counts=jsonb_set(counts,'{excludedNativeDocuments}',to_jsonb(COALESCE((counts->>'excludedNativeDocuments')::int,0)+1)) WHERE id=$1",[scanId]);}
   await c.query('UPDATE image_backup_scan_entries SET data=$3 WHERE scan_id=$1 AND entry_key=$2',[scanId,entry.entry_key,JSON.stringify(next)]);
  });data=next;
 }
 if(data.page.offset===data.page.files.length){
  const next={...data,pageToken:data.page.nextPageToken};delete next.page;
  await transaction(d.pool,async c=>{await owned(c);await c.query('UPDATE image_backup_scan_entries SET data=$3,state=$4 WHERE scan_id=$1 AND entry_key=$2',[scanId,entry.entry_key,JSON.stringify(next),next.pageToken?'pending':'done']);});
 }
 }
 // Superseded job (source changed after enqueue): re-observe ONLY that file, bounded per file.
 const superseded=(await d.pool.query("SELECT e.entry_key,e.data,e.job_key FROM image_backup_scan_entries e JOIN image_backup_outbox o ON o.job_key=e.job_key WHERE e.scan_id=$1 AND e.kind='file' AND e.state='pending' AND o.status='superseded' ORDER BY e.entry_key LIMIT 100",[scanId])).rows;
 for(const old of superseded){if(!withinBudget())break;const live=await observeLive({fileId:old.entry_key.slice(5),deps:d});await transaction(d.pool,async c=>{await owned(c);await revisit(c,{scanId,key:old.entry_key,old,live});});}
 await d.pool.query("UPDATE image_backup_scan_entries e SET state='done' FROM image_backup_outbox o WHERE e.scan_id=$1 AND e.kind='file' AND e.state='pending' AND e.job_key=o.job_key AND o.status='done' AND EXISTS(SELECT 1 FROM image_backup_scans WHERE id=$1 AND lease_token=$2 AND lease_until>now())",[scanId,token]);
 const left=(await d.pool.query("SELECT count(*) FILTER (WHERE state NOT IN ('done','excluded','unresolved'))::int pending,count(*) FILTER (WHERE state='unresolved')::int unresolved FROM image_backup_scan_entries WHERE scan_id=$1",[scanId])).rows[0];
 if(left.pending)return {state:'running',cursor:{scanId}};
 // Unresolved files never become complete: honest incomplete, no new current.
 // Ends as 'failed' (never complete, not resumable) so the single active-scan slot is freed for the next night.
 if(left.unresolved){await d.pool.query("UPDATE image_backup_scans SET state='failed',counts=counts||jsonb_build_object('lastError','UNRESOLVED_ENTRIES','unresolved',$3::int) WHERE id=$1 AND lease_token=$2 AND lease_until>now()",[scanId,token,left.unresolved]);return {state:'incomplete',cursor:{scanId,reason:'UNRESOLVED_ENTRIES',unresolved:left.unresolved}};}
 const complete=await publishStep({scan,token,deps:d});return {state:complete?'complete':'running',cursor:complete?null:{scanId,phase:'publishing'}};
 }catch(e){await d.pool.query("UPDATE image_backup_scans SET state=$4,counts=counts||jsonb_build_object('lastError',$3::text) WHERE id=$1 AND lease_token=$2 AND lease_until>now()",[scanId,token,e.code||'SCAN_FAILED',e.code==='PRECONDITION_FAILED'?'failed':'incomplete']);return {state:'incomplete',cursor:{scanId,reason:e.code||'SCAN_FAILED'}};
 }finally{await d.pool.query('UPDATE image_backup_scans SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2',[scanId,token]);}
}
// Publication is resumable at one immutable part / 100 DB receipts per step.
async function publishStep({scan,token,deps:d}){
 const generation=String(scan.id);let p=scan.counts.publication;
 async function save(next){const r=await d.pool.query("UPDATE image_backup_scans SET state='publishing',counts=counts||jsonb_build_object('publication',$3::jsonb) WHERE id=$1 AND lease_token=$2 AND lease_until>now() RETURNING id",[scan.id,token,JSON.stringify(next)]);if(!r.rows.length)throw fail('LEASE_LOST');p=next;}
 async function stage(entries){await transaction(d.pool,async c=>{const r=await c.query('SELECT id FROM image_backup_scans WHERE id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',[scan.id,token]);if(!r.rows.length)throw fail('LEASE_LOST');for(const e of entries){if(!/^[a-f0-9]{64}$/.test(e.receiptId)||e.key!==backup.objectKey(e.descriptor,e.sha256))throw fail('VERIFY_FAILED');await c.query("INSERT INTO image_backup_scan_entries(scan_id,entry_key,kind,data,state) VALUES($1,$2,'file',$3,'done') ON CONFLICT(scan_id,entry_key) DO UPDATE SET data=EXCLUDED.data",[scan.id,'receipt:'+e.receiptId,JSON.stringify(e)]);}});}
 if(!p){const upper=(await d.pool.query('SELECT COALESCE(max(id),0)::text id FROM image_backup_outbox')).rows[0].id;await save({phase:'previous',previousPart:0,upper,after:'0',parts:[],partAfter:'',verifyPart:0});return false;}
 if(p.phase==='previous'){
  if(scan.base_generation){const r=await d.api.readManifest({generation:scan.base_generation,part:'index'}),index=JSON.parse(r.bytes),current=await d.api.readCurrent();if(current?.generation!==scan.base_generation||backup.sha(r.bytes)!==current.indexSha256||index.scanComplete!==true)throw fail('PRECONDITION_FAILED');
   if(p.previousPart<index.parts.length){const ref=index.parts[p.previousPart],part=await d.api.readManifest({generation:scan.base_generation,part:ref.part});if(backup.sha(part.bytes)!==ref.sha256||part.bytes.length!==ref.size)throw fail('VERIFY_FAILED');const entries=JSON.parse(part.bytes).entries;if(entries.length!==ref.count)throw fail('VERIFY_FAILED');await stage(entries.map(e=>({...e,presence:'not_observed'})));await save({...p,previousPart:p.previousPart+1});return false;}}
  await save({...p,phase:'outbox'});return false;
 }
 if(p.phase==='outbox'){
  const rows=(await d.pool.query("SELECT * FROM image_backup_outbox WHERE id>$1 AND id<=$2 AND status='done' ORDER BY id LIMIT 100",[p.after,p.upper])).rows;
  const entries=[];for(const row of rows){const descriptor=row.observation.descriptor,r=row.receipt;if(!descriptor||!r)throw fail('VERIFY_FAILED');const proof=row.observation.md5Checksum?{kind:'drive-md5',md5:row.observation.md5Checksum,size:descriptor.size,sourceVersion:descriptor.sourceVersion}:{kind:'drive-sha256',sha256:r.sha256,size:descriptor.size,sourceVersion:descriptor.sourceVersion};backup.verifyReceipt(r,descriptor,proof);
   const seen=(await d.pool.query("SELECT 1 FROM image_backup_scan_entries WHERE scan_id=$1 AND job_key=$2 AND state='done' LIMIT 1",[scan.id,row.job_key])).rows.length>0;
   entries.push({receiptId:r.receiptId,key:r.key,fileId:r.fileId,sha256:r.sha256,size:r.size,mime:r.mime,descriptor,proof,presence:seen?'observed':'not_observed'});}
  await stage(entries);if(rows.length){await save({...p,after:String(rows[rows.length-1].id)});return false;}
  const unresolved=(await d.pool.query("SELECT count(*)::int n FROM image_backup_outbox WHERE id<=$1 AND status IN ('pending','retry','running','blocked')",[p.upper])).rows[0].n;if(unresolved)throw fail('UNRESOLVED_OUTBOX');await save({...p,phase:'parts'});return false;
 }
 if(p.phase==='parts'){
  const rows=(await d.pool.query("SELECT entry_key,data FROM image_backup_scan_entries WHERE scan_id=$1 AND entry_key LIKE 'receipt:%' AND entry_key>$2 ORDER BY entry_key LIMIT 100",[scan.id,p.partAfter])).rows;
  if(rows.length){const part='p'+String(p.parts.length).padStart(6,'0'),entries=[];let bytes;for(const row of rows){const candidate=Buffer.from(JSON.stringify({v:1,generation,part,entries:[...entries,row.data]}));if(candidate.length>256*1024){if(!entries.length)throw fail('TOO_LARGE');break;}entries.push(row.data);bytes=candidate;}
   const ref={part,sha256:backup.sha(bytes),size:bytes.length,count:entries.length};await d.api.putManifestPart({generation,part,bytes,sha256:ref.sha256});await save({...p,parts:[...p.parts,ref],partAfter:rows[entries.length-1].entry_key});return false;}
  await save({...p,phase:'verify'});return false;
 }
 if(p.phase==='verify'){
  if(p.verifyPart<p.parts.length){const ref=p.parts[p.verifyPart],r=await d.api.readManifest({generation,part:ref.part});if(backup.sha(r.bytes)!==ref.sha256||r.bytes.length!==ref.size)throw fail('VERIFY_FAILED');const part=JSON.parse(r.bytes);if(part.generation!==generation||part.part!==ref.part||part.entries.length!==ref.count)throw fail('VERIFY_FAILED');const ids=new Set();for(const e of part.entries){if(ids.has(e.receiptId))throw fail('VERIFY_FAILED');ids.add(e.receiptId);const stored=(await d.pool.query('SELECT data FROM image_backup_scan_entries WHERE scan_id=$1 AND entry_key=$2',[scan.id,'receipt:'+e.receiptId])).rows[0];if(!stored||backup.canonical(stored.data)!==backup.canonical(e))throw fail('VERIFY_FAILED');}await save({...p,verifyPart:p.verifyPart+1});return false;}
  const total=(await d.pool.query("SELECT count(*)::int n FROM image_backup_scan_entries WHERE scan_id=$1 AND entry_key LIKE 'receipt:%'",[scan.id])).rows[0].n;if(total!==p.parts.reduce((n,r)=>n+r.count,0))throw fail('VERIFY_FAILED');
  const bytes=Buffer.from(JSON.stringify({v:1,generation,baseGeneration:scan.base_generation,rootSetHash:scan.root_set_hash,scanComplete:true,parts:p.parts,counts:{receipts:total}}));if(bytes.length>1024*1024)throw fail('TOO_LARGE');await d.api.putManifestPart({generation,part:'index',bytes,sha256:backup.sha(bytes)});await save({...p,phase:'commit',indexSha256:backup.sha(bytes)});return false;
 }
 if(p.phase==='commit'){
  const r=await d.api.readManifest({generation,part:'index'});if(backup.sha(r.bytes)!==p.indexSha256)throw fail('VERIFY_FAILED');let current=await d.api.readCurrent();
  if(current?.generation!==generation||current.indexSha256!==p.indexSha256){const own=await d.pool.query('SELECT id FROM image_backup_scans WHERE id=$1 AND lease_token=$2 AND lease_until>now()',[scan.id,token]);if(!own.rows.length)throw fail('LEASE_LOST');await d.api.commitManifest({generation,baseGeneration:scan.base_generation,expectedEtag:scan.base_etag,indexBytes:r.bytes});current=await d.api.readCurrent();}
  if(current?.generation!==generation||current.indexSha256!==p.indexSha256)throw fail('VERIFY_FAILED');const done=await d.pool.query("UPDATE image_backup_scans SET state='complete',completed_at=now() WHERE id=$1 AND lease_token=$2 AND lease_until>now() RETURNING id",[scan.id,token]);if(!done.rows.length)throw fail('LEASE_LOST');return true;
 }
 throw fail('INVALID_STATE');
}
module.exports={MAX_FILE_REVISITS,observeLive,config,dependencies,loadHints,resolveActualPath,classifyScope,observe,transaction,startScan,scanStep,publishStep};
