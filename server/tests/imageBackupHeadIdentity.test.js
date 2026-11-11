'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {createClient}=require('../src/services/imageBackupClient.service');
(async()=>{
 const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>');
 const hash=createHash('sha256').update(bytes).digest('hex');
 const requests=[];
 const server=http.createServer((req,res)=>{
  requests.push({method:req.method,encoding:req.headers['accept-encoding']});
  res.setHeader('Content-Type','image/svg+xml');res.setHeader('X-Backup-Sha256',hash);
  if(req.headers['accept-encoding']==='identity')res.setHeader('Content-Length',String(bytes.length));
  else res.setHeader('Content-Encoding','gzip'); // Cloudflare HEAD can omit wire length for a negotiated representation.
  res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const local='http://127.0.0.1:'+server.address().port;
  const client=createClient({url:'https://backup.invalid',apiKey:'fixture-only',fetch:(url,opts)=>fetch(local+new URL(url).pathname,opts)});
  const head=await client.headObject({key:'fixture.svg'});
  assert.equal(head.size,bytes.length,'HEAD must request original-byte length instead of a compressed/unknown wire length');
  assert.equal(head.sha256,hash);assert.equal(head.mime,'image/svg+xml');
  assert.deepEqual(requests,[{method:'HEAD',encoding:'identity'}]);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 // Preservation contract: ordinary reads retain their existing request shape.
 const ordinary=[];
 const reader=createClient({url:'https://backup.invalid',apiKey:'fixture-only',fetch:async(url,opts)=>{
  ordinary.push(opts);return new Response(JSON.stringify({v:1}),{status:200});
 }});
 assert.deepEqual(await reader.readCurrent(),{v:1});
 assert.equal(ordinary[0].method,'GET');assert.equal(ordinary[0].headers['Accept-Encoding'],undefined);
 console.log('PASS imageBackupHeadIdentity: native HTTP original SVG length/SHA; ordinary GET unchanged');
})().catch(e=>{console.error(e);process.exitCode=1;});
