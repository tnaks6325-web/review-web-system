#!/usr/bin/env node
'use strict';
// No dotenv, business pool, Drive or warm import. restore-audit only uses BACKUP API.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const b=require('../src/services/imageBackup.service');
function fail(){throw new Error('VERIFY_FAILED');}
async function listAll(api,kind){const items=[],seen=new Set(),keys=new Set();let cursor=null;do{const p=await api.listManifests({kind,cursor,limit:1000});if(!Array.isArray(p.items)||typeof p.truncated!=='boolean')fail();for(const i of p.items){if(keys.has(i.key))fail();keys.add(i.key);items.push(i);}if(p.truncated&&(!p.cursor||seen.has(p.cursor)))fail();cursor=p.truncated?p.cursor:null;if(cursor)seen.add(cursor);}while(cursor);return items;}
async function restoreAudit({api,directory,sample=20,allBytes=false}){
 if(!Number.isSafeInteger(sample)||sample<20||sample>10000)throw new Error('SAMPLE_RANGE');
 if(!directory)throw new Error('RESTORE_DIRECTORY_REQUIRED');fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
 const startedAt=new Date().toISOString();
 const running={v:1,state:'incomplete',startedAt,gateReady:false,unverified:['현재 감사 실행이 아직 완료되지 않았습니다']};
 fs.writeFileSync(path.join(directory,'audit.json'),JSON.stringify(running,null,2),{mode:0o600});
 fs.writeFileSync(path.join(directory,'report.html'),htmlReport(running),{mode:0o600});
 const receipts=new Map(),entries=new Map(),currentEntries=new Map(),indexes=new Map(),partReferences=new Set();
 const current=await api.readCurrent();
 for(const item of await listAll(api,'receipts')){
  const m=/^manifests\/receipts\/([a-f0-9]{64})\.json$/.exec(item.key);if(!m)fail();
  const r=await api.getReceipt({receiptId:m[1]});const record=JSON.parse(r.bytes);if(record.v!==1)fail();const receipt=b.verifyReceipt(record.object,record.descriptor,record.proof);if(receipt.receiptId!==m[1])fail();
  if(item.size!==undefined&&item.size!==r.bytes.length)fail();receipts.set(m[1],record);
 }
 const generations=await listAll(api,'generations');
 for(const item of generations){const m=/^manifests\/([1-9][0-9]*)\/index$/.exec(item.key);if(!m)continue;const r=await api.readManifest({generation:m[1],part:'index'}),index=JSON.parse(r.bytes);if(item.size!==undefined&&item.size!==r.bytes.length)fail();if(index.v!==1||index.generation!==m[1]||index.scanComplete!==true||!Array.isArray(index.parts))fail();if(current?.generation===m[1]&&b.sha(r.bytes)!==current.indexSha256)fail();indexes.set(m[1],index);const ids=new Set();let count=0;
  for(let i=0;i<index.parts.length;i++){const ref=index.parts[i];if(ref.part!=='p'+String(i).padStart(6,'0'))fail();const p=await api.readManifest({generation:m[1],part:ref.part});if(p.bytes.length!==ref.size||b.sha(p.bytes)!==ref.sha256)fail();const part=JSON.parse(p.bytes);if(part.v!==1||part.generation!==m[1]||part.part!==ref.part||part.entries.length!==ref.count)fail();partReferences.add(m[1]+'/'+ref.part);
   for(const entry of part.entries){if(ids.has(entry.receiptId)||!['observed','not_observed','unresolved'].includes(entry.presence))fail();ids.add(entry.receiptId);const receipt=receipts.get(entry.receiptId);if(!receipt)fail();for(const k of ['key','fileId','sha256','size','mime'])if(entry[k]!==receipt.object[k])fail();if(b.canonical(entry.descriptor)!==b.canonical(receipt.descriptor)||b.canonical(entry.proof)!==b.canonical(receipt.proof))fail();entries.set(entry.receiptId,entry);if(current?.generation===m[1])currentEntries.set(entry.receiptId,entry);count++;}
  }
  if(index.counts.receipts!==undefined&&index.counts.receipts!==count)fail();
 }
 if(current&&!indexes.has(current.generation))fail();
 // Read even orphan parts: immutable upload may have stopped before index/current.
 let orphanParts=0;for(const item of generations){const m=/^manifests\/([1-9][0-9]*)\/(p[0-9]{6})$/.exec(item.key);if(m&&!partReferences.has(m[1]+'/'+m[2])){const r=await api.readManifest({generation:m[1],part:m[2]}),part=JSON.parse(r.bytes);if(part.v!==1||part.generation!==m[1]||part.part!==m[2]||!Array.isArray(part.entries))fail();if(item.size!==undefined&&r.bytes.length!==item.size)fail();for(const e of part.entries){const rec=receipts.get(e.receiptId);if(!rec||e.sha256!==rec.object.sha256||e.key!==rec.object.key)fail();}orphanParts++;}}
 const rows=[...receipts.values()],objectRows=new Map(rows.map(r=>[r.object.key,r]));for(const r of objectRows.values()){const head=await api.headObject({key:r.object.key});if(head.size!==r.object.size||head.sha256!==r.object.sha256)fail();}
 const layers=new Map(),versions=new Map();const add=(k,r)=>{if(!layers.has(k))layers.set(k,r);};
 for(const r of rows){const d=r.descriptor;add(d.section,r);if(d.mime==='image/svg+xml')add('svg',r);if(!/\.[^.]+$/.test(d.name))add('no_extension',r);add(r.proof.kind,r);if(currentEntries.get(r.object.receiptId)?.presence==='not_observed')add('not_observed',r);const v=versions.get(d.fileId)||[];v.push(r);versions.set(d.fileId,v);}
 for(const v of versions.values())if(v.length>1){const named=new Set(v.map(r=>b.canonical({chain:r.descriptor.chain,name:r.descriptor.name})));if(named.size>1){add('rename_old',v[0]);add('rename_new',v[v.length-1]);}}
 const selected=new Map();for(const r of layers.values())selected.set(r.object.receiptId,r);
 // Additional random sample (without replacement), not twenty including strata.
 const random=rows.filter(r=>!selected.has(r.object.receiptId));for(let i=0;i<Math.min(Math.max(20,sample),random.length);i++){const j=i+crypto.randomInt(random.length-i);[random[i],random[j]]=[random[j],random[i]];selected.set(random[i].object.receiptId,random[i]);}
 if(allBytes)for(const r of rows)selected.set(r.object.receiptId,r);
 for(const r of selected.values()){const object=await api.getObject({key:r.object.key});if(object.bytes.length!==r.object.size||b.sha(object.bytes)!==r.object.sha256)fail();const target=path.join(directory,r.object.receiptId+'.bin');fs.writeFileSync(target,object.bytes,{mode:0o600});const readback=fs.readFileSync(target);if(readback.length!==r.object.size||b.sha(readback)!==r.object.sha256)fail();}
 const required=['work','common','internal','svg','no_extension','rename_old','rename_new','not_observed'];
 const groupMap=new Map();for(const r of rows){const descriptor=r.descriptor,key=b.canonical({section:descriptor.section,rootId:descriptor.rootId,chain:descriptor.chain});let group=groupMap.get(key);if(!group){group={section:descriptor.section,chain:descriptor.chain,preservedVersions:0,observed:new Set(),notObservedVersions:0};groupMap.set(key,group);}group.preservedVersions++;const presence=currentEntries.get(r.object.receiptId)?.presence;if(presence==='observed')group.observed.add(descriptor.fileId);if(presence==='not_observed')group.notObservedVersions++;}
 const groups=[...groupMap.values()].map(({observed,...group})=>({...group,observedFiles:current?observed.size:null}));
 const report={v:1,state:'complete',startedAt,groups,currentGeneration:current?.generation||null,objects:objectRows.size,receipts:rows.length,heads:objectRows.size,indexes:indexes.size,manifestReferences:entries.size,orphanParts,restored:selected.size,selected:[...selected.keys()],selectedObjects:[...selected.values()].map(r=>({receiptId:r.object.receiptId,sha256:r.object.sha256,size:r.object.size})),layers:[...layers.keys()],missingLayers:required.filter(k=>!layers.has(k)),fullByteAudit:allBytes,inventoryComplete:true,gateReady:false,
  unverified:['운영 승인 범위 대조·원본 생존범위·복사/Drive fallback 출처별 운영증거는 별도 확인 필요',...(!allBytes?['독립 전체 바이트 전수 감사 미검증']:[])]};
 fs.writeFileSync(path.join(directory,'receipts.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
 fs.writeFileSync(path.join(directory,'audit.json'),JSON.stringify(report,null,2),{mode:0o600});fs.writeFileSync(path.join(directory,'report.html'),htmlReport(report),{mode:0o600});return report;
}
function htmlReport(report){const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const table='<table border="1" cellpadding="8"><tr><th>구획 · 실제 폴더</th><th>최근 완료 점검에서 본 원본</th><th>보존 사본 버전</th><th>이번에 관측되지 않은 버전</th></tr>'+(report.groups||[]).map(g=>'<tr><td>'+esc(g.section+' · '+g.chain.map(p=>p.name).join(' / '))+'</td><td>'+esc(g.observedFiles===null?'미확인':g.observedFiles)+'</td><td>'+esc(g.preservedVersions)+'</td><td>'+esc(g.notObservedVersions)+'</td></tr>').join('')+'</table>';return '<!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>사진 사본 점검</title><h1>사진 사본 점검</h1><p>운영 전환 합격 여부는 별도 확인 · 미검증 항목 포함. 사본은 삭제·교체·옛 이름도 보존하므로 원본과 수가 달라도 정상일 수 있습니다. 최근 완료 점검은 현재 시각의 Drive 실시간 조회가 아닙니다.</p>'+table+'<pre>'+esc(JSON.stringify(report,null,2))+'</pre></html>';}
async function main(args=process.argv.slice(2)){
 const command=args[0]||'dry-run';const opt=k=>{const at=args.indexOf('--'+k);return at<0?undefined:args[at+1];};
 if(command==='--help'||command==='help'){console.log('image-backup.js dry-run | status | scan [--scan-id ID] [--budget-ms 10000] | drain [--count 1] | retry --job-key KEY | restore-audit --directory PATH [--sample 20] [--all-bytes] | report --input audit.json --output report.html\nNo workflow disable/delete command. dry-run validates config/schema/root readers without enqueue/write. restore-audit uses BACKUP API only.');return;}
 if(command==='restore-audit'){const api=require('../src/services/imageBackupClient.service').createClient();return restoreAudit({api,directory:opt('directory'),sample:Number(opt('sample')||20),allBytes:args.includes('--all-bytes')});}
 if(command==='report'){const report=JSON.parse(fs.readFileSync(opt('input'),'utf8'));fs.writeFileSync(opt('output'),htmlReport(report),{mode:0o600});return {written:true};}
 if(!['dry-run','status','scan','drain','retry'].includes(command))throw new Error('UNKNOWN_COMMAND');
 if(['scan','drain','retry'].includes(command)&&!b.enabled())throw new Error('BACKUP_DISABLED');
 const pool=require('../src/db/imageBackupPool').getPool();try{
 const schema=await b.checkBackupSchema({pool});if(!schema.ready){if(['scan','drain','retry'].includes(command))throw new Error('BACKUP_SCHEMA_UNAVAILABLE');return {ready:false,missing:schema.missing};}
 if(command==='status')return {schema,jobs:(await pool.query('SELECT status,count(*)::int count FROM image_backup_outbox GROUP BY status ORDER BY status')).rows,scans:(await pool.query('SELECT id,state,counts,started_at,completed_at FROM image_backup_scans ORDER BY id DESC LIMIT 20')).rows};
 const scan=require('../src/services/imageBackupScan.service');
 if(command==='dry-run'){const d=await scan.dependencies({pool});const observations=[];for(const root of d.roots)for(const kind of root.readerKinds){const reader=d.readers.find(r=>r.kind===kind);if(!reader)throw new Error('READER_UNAVAILABLE');await reader.getMetadata(root.rootId);const p=await reader.listChildren(root.rootId,null);if(p.incompleteSearch||!Array.isArray(p.files))throw new Error('INCOMPLETE_SEARCH');observations.push({readerKind:kind,firstPageCount:p.files.length,hasMore:!!p.nextPageToken});}return {ready:true,enabled:b.enabled(),schema,observations,fullInventory:false};}
 if(command==='retry'){if(!opt('job-key'))throw new Error('JOB_KEY_REQUIRED');return b.retryJob({pool,jobKey:opt('job-key')});}
 if(command==='scan'){const id=opt('scan-id')||(await scan.startScan({deps:{pool}})).id;return scan.scanStep({scanId:id,budgetMs:Number(opt('budget-ms')||10000),deps:{pool}});}
 const count=Number(opt('count')||1);if(!Number.isSafeInteger(count)||count<1||count>1000)throw new Error('COUNT_RANGE');const totals={claimed:0,verified:0,retry:0,blocked:0};for(let i=0;i<count;i++){const r=await b.drainOnce({deps:{pool}});for(const k of Object.keys(totals))totals[k]+=r[k];if(!r.claimed)break;}return totals;
 }finally{await require('../src/db/imageBackupPool').close();}
}
if(require.main===module)main().then(r=>{if(r)console.log(JSON.stringify(r,null,2));}).catch(()=>{console.error('image-backup: failed; backup incomplete (no secret/details logged)');process.exitCode=1;});
module.exports={main,restoreAudit,htmlReport,listAll};
