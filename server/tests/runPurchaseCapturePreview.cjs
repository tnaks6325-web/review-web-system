'use strict';
// Local interactive acceptance harness; no production DB/Drive/message delivery.
const fs=require('node:fs');
const {start}=require('./helpers/purchaseCaptureBrowserHarness');
const {BUNDLE}=require('./helpers/purchaseCaptureIntegrationFixture');
(async()=>{
 const h=await start({port:Number(process.env.CAPTURE_PREVIEW_PORT||8847)});
 const file=process.env.CAPTURE_PREVIEW_IMAGE;
 if(file&&fs.existsSync(file)){const bytes=fs.readFileSync(file);for(const id of h.files.keys())h.files.set(id,Buffer.from(bytes));}
 const session={ownerReviewerId:'11111111-1111-4111-8111-111111111111',loginKind:'self',loginPhone8:'12345678',loginName:'시험 리뷰어'};
 const item=(await h.core.getForReviewer({session,orderSubmissionId:BUNDLE})).item;
 await h.checks.requestCheck({session,orderSubmissionId:BUNDLE,channel:'naver',expectedEvidenceHash:item.channels.find(c=>c.channel==='naver').evidenceHash,note:'로컬 시험용 확인요청입니다.'});
 console.log('REVIEWER_PREVIEW='+h.base+'/integrated-preview');
 console.log('STAFF_PREVIEW='+h.base+'/staff-preview');
 console.log('LOCAL_ONLY: PGlite + in-memory fake Drive; restart resets all test data.');
 process.once('SIGTERM',()=>h.close().then(()=>process.exit(0)));
 process.once('SIGINT',()=>h.close().then(()=>process.exit(0)));
})().catch(error=>{console.error(error);process.exitCode=1;});
