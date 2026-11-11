'use strict';
const assert=require('node:assert/strict');
(async()=>{
 let calls=[];const client=require('../src/services/imageBackupClient.service').createClient({url:'https://backup.invalid',apiKey:'independent-test-key',fetch:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({v:1,ok:true}),{status:200});}});
 const descriptor={fileId:'file00000001'},proof={kind:'drive-md5'};
 await client.copyOrig({descriptor,proof});assert.equal(calls[0].url,'https://backup.invalid/v1/objects/copy');assert.equal(calls[0].o.method,'POST');assert.deepEqual(JSON.parse(calls[0].o.body),{v:1,descriptor,proof});assert.equal(calls[0].o.headers.Authorization,'Bearer independent-test-key');
 await client.putObject({descriptor,proof,body:Buffer.from('abc')});assert.deepEqual(JSON.parse(Buffer.from(calls[1].o.headers['X-Backup-Descriptor'],'base64url')),{v:1,descriptor,proof});
 await client.commitManifest({generation:'3',baseGeneration:'2',expectedEtag:'etag',indexBytes:Buffer.from('index')});assert.deepEqual(JSON.parse(calls[2].o.body),{v:1,generation:'3',baseGeneration:'2',expectedEtag:'etag',indexSha256:require('crypto').createHash('sha256').update('index').digest('hex')});
 const fail=require('../src/services/imageBackupClient.service').createClient({url:'https://backup.invalid',apiKey:'test',fetch:async()=>new Response(JSON.stringify({v:1,error:{code:'SOURCE_MISSING',retryable:false}}),{status:404})});await assert.rejects(fail.copyOrig({descriptor,proof}),e=>e.code==='SOURCE_MISSING');
 console.log('PASS imageBackupClient: fixed wire copy/put/current, error code (4 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
