'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
(async()=>{
 const cli=require('../scripts/image-backup');assert.equal(typeof cli.restoreAudit,'function');
 const b=require('../src/services/imageBackup.service'),body=Buffer.from('abc'),descriptor={fileId:'file00000001',rootId:'root00000001',chain:[{id:'root00000001',name:'r'}],name:'x',mime:'image/jpeg',size:3,sourceVersion:'1',section:'internal'},proof={kind:'drive-sha256',sha256:b.sha(body),size:3,sourceVersion:'1'};
 const key=b.objectKey(descriptor,b.sha(body)),receiptId=b.sha(b.canonical({descriptor,proof,key,sha256:b.sha(body),size:3,mime:'image/jpeg'}));const receipt={v:1,key,fileId:descriptor.fileId,sha256:b.sha(body),size:3,mime:'image/jpeg',objectEtag:'e',receiptId,verified:true};
 const api={listManifests:async({kind})=>({items:kind==='receipts'?[{key:'manifests/receipts/'+receiptId+'.json'}]:[],truncated:false,cursor:null}),getReceipt:async()=>({bytes:Buffer.from(JSON.stringify({v:1,descriptor,proof,object:receipt}))}),readCurrent:async()=>null,headObject:async()=>({size:3,sha256:b.sha(body),mime:'image/jpeg'}),getObject:async()=>({bytes:body})};
 const dest=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'backup-audit-'));
 try{const report=await cli.restoreAudit({api,directory:dest,sample:20});assert.equal(report.objects,1);assert.equal(report.restored,1);assert.equal(report.fullByteAudit,false);assert.equal(report.gateReady,false);assert.ok(Array.isArray(report.groups),'grouped inventory report exists');assert.equal(report.groups[0].observedFiles,null,'no published inventory is unknown, not zero');assert.equal(report.groups[0].preservedVersions,1);assert.ok(fs.existsSync(path.join(dest,receiptId+'.bin')));
 const bad={...api,getObject:async()=>({bytes:Buffer.from('abd')})};await assert.rejects(cli.restoreAudit({api:bad,directory:dest,sample:20}),/VERIFY_FAILED/);
 assert.ok(cli.htmlReport(report).includes('미검증'));assert.ok(!cli.htmlReport({x:'<script>'}).includes('<script>'));
 }finally{fs.rmSync(dest,{recursive:true,force:true});}
 console.log('PASS imageBackupCli: independent receipt-only restore, HEAD inventory, body corruption rejected, no false gate, HTML escape (5 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
