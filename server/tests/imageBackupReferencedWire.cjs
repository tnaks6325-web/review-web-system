'use strict';
// Standalone opt-in (결정 368 참조 사진): node server/tests/imageBackupReferencedWire.cjs [../backup-worker]
// Actual Worker handler (A) + server client/drain/scan/publisher/restore audit (B), with one approved-root photo
// and one REFERENCED photo directly in the My Drive root. No production credentials/network.
const assert=require('node:assert/strict');const path=require('node:path'),fs=require('node:fs');const {pathToFileURL}=require('node:url');
const base=path.resolve(__dirname,'..');const worker=path.resolve(process.argv[2]||path.join(base,'../backup-worker'));
(async()=>{
 const {PGlite}=require(base+'/node_modules/@electric-sql/pglite');
 const helpers=await import(pathToFileURL(worker+'/tests/helpers.js'));const handler=(await import(pathToFileURL(worker+'/src/index.js'))).default;
 const b=require(base+'/src/services/imageBackup.service'),s=require(base+'/src/services/imageBackupScan.service');
 const MYD='mydrive_0123456789',FREF='fileref_0123456789',root=helpers.d.rootId,FAPP='fileapp_0123456789',body=Buffer.from('abc'),FOLDER='application/vnd.google-apps.folder';
 const env=helpers.env();env.IMAGE_BACKUP_REFERENCED_ROOT_IDS=JSON.stringify([MYD]);
 const api=require(base+'/src/services/imageBackupClient.service').createClient({url:'https://backup.invalid',apiKey:env.IMAGE_BACKUP_API_KEY,fetch:(url,opts)=>handler.fetch(new Request(url,opts),env,{waitUntil(){}})});
 const file=(id,parent)=>({id,name:id+'.jpg',mimeType:'image/jpeg',version:'5',parents:[parent],size:'3',md5Checksum:helpers.proof.md5,modifiedTime:'2026-11-22T00:00:00.000Z'});
 const meta={[MYD]:{id:MYD,name:'내 드라이브',mimeType:FOLDER},[root]:{id:root,name:'[리뷰]',mimeType:FOLDER},[FAPP]:file(FAPP,root),[FREF]:file(FREF,MYD)};
 const listed=[];const reader={kind:'oauth',getMetadata:async id=>{if(!meta[id])throw Object.assign(new Error('nf'),{code:404});return JSON.parse(JSON.stringify(meta[id]));},listChildren:async id=>{listed.push(id);return {files:Object.values(meta).filter(m=>(m.parents||[]).includes(id)),nextPageToken:null};},download:async()=>body};
 const db=new PGlite();for(const f of ['223_image_group_backup.sql','226_image_backup_outbox_file_idx.sql'])await db.exec(fs.readFileSync(base+'/migrations/'+f,'utf8'));
 await db.exec(`CREATE TABLE tab_configs(sheet_id text,tab_name text,capture_slots jsonb,income_type text);CREATE TABLE review_submissions(file_id text,slot_key text,evidence_role text,sheet_id text,tab_name text);CREATE TABLE review_edit_requests(new_file_id text,old_file_id text,slot_key text,status text,sheet_id text,tab_name text);CREATE TABLE guide_image_files(file_id text PRIMARY KEY,source text);CREATE TABLE payment_result_drive_archive(drive_file_id text);CREATE TABLE order_submissions(capture_file_id text,capture_file_id_2 text);CREATE TABLE purchase_capture_artifacts(file_id text);CREATE TABLE purchase_capture_supplements(file_id text);CREATE TABLE purchase_submission_sessions(capture_file_id text);CREATE TABLE review_index(review_file_id text);CREATE TABLE review_inspections(file_id text);CREATE TABLE review_photo_relinks(file_id text);`);
 await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[FREF]);
 const deps={pool:db,roots:[{rootId:root,readerKinds:['oauth']}],excluded:[],referenced:[MYD],readers:[reader],api,loadHints:s.loadHints};
 // Gap sweep picks the referenced photo (no outbox row yet); drain backs it up through the real Worker.
 assert.equal((await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD]})).enqueued,1);
 for(let i=0;i<3;i++)await b.drainOnce({deps});
 const done=(await db.query("SELECT observation,receipt FROM image_backup_outbox WHERE status='done'")).rows;assert.equal(done.length,1);assert.equal(done[0].observation.descriptor.rootId,MYD);
 const scan=await s.startScan({deps});let st;for(let i=0;i<25;i++){st=await s.scanStep({scanId:scan.id,deps});if(st.state==='incomplete')throw Error(JSON.stringify(st));for(let j=0;j<3;j++)await b.drainOnce({deps});if(st.state==='complete')break;}
 assert.equal(st.state,'complete');assert.ok(!listed.includes(MYD),'referenced root never enumerated');
 await db.close();reader.getMetadata=async()=>{throw Error('Drive forbidden during audit');};reader.download=reader.getMetadata;
 const restoreApi=Object.fromEntries(['readCurrent','listManifests','getReceipt','readManifest','headObject','getObject'].map(k=>[k,api[k]]));
 const dest=fs.mkdtempSync(path.join(process.env.TMPDIR,'backup-ref-wire-'));
 try{const report=await require(base+'/scripts/image-backup').restoreAudit({api:restoreApi,directory:dest,sample:20,allBytes:true});
  assert.equal(report.objects,2);assert.equal(report.restored,2);assert.equal(report.indexes,1);assert.ok(report.layers.includes('not_observed'),'referenced copy published as not_observed');
  assert.ok(report.groups.some(g=>g.chain[0].id===MYD&&g.preservedVersions===1));
  console.log('PASS referenced wire: real Worker accepted My-Drive-root top, gap sweep→drain→done, scan published (referenced root not listed, presence not_observed), independent full restore 2/2');
 }finally{fs.rmSync(dest,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
