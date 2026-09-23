'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const src=fs.readFileSync(require('path').join(__dirname,'../../frontend/index.html'),'utf8');
const fn=src.slice(src.indexOf('async function _loadReviewEarnings('),src.indexOf('/** 상단 금액 요약 카드'));
const old={totals:{count:1,grandTotal:9000},doneTotals:{count:1},items:{old:{productPrice:9000}}};
let checks=0;
async function run(fetchImpl){const c=vm.createContext({_historySessionKey:'one',_reviewEarnings:structuredClone(old),API_BASE_URL:'',_getAuthHeaders:()=>({}),fetch:fetchImpl,renderReviewSummary(){},renderReviewSubTab(){}});vm.runInContext(fn,c);return c;}
(async()=>{
 for(const response of [{ok:false,code:'REVIEW_EARNINGS_DEFERRED'},null]){
  const c=await run(async()=>({json:async()=>response}));await c._loadReviewEarnings('11112222');assert.equal(c._reviewEarnings.totals,null);assert.equal(Object.keys(c._reviewEarnings.items).length,0);checks++;
 }
 const failed=await run(async()=>{throw Error('network');});await failed._loadReviewEarnings('11112222');assert.equal(failed._reviewEarnings.doneTotals,null);checks++;
 const good=await run(async()=>({json:async()=>({ok:true,totals:{count:2},items:{fresh:{}}})}));await good._loadReviewEarnings('11112222');assert.equal(good._reviewEarnings.totals.count,2);checks++;
 let done;const late=await run(()=>new Promise(r=>{done=r;}));const p=late._loadReviewEarnings('11112222');late._historySessionKey='two';done({json:async()=>({ok:false})});await p;assert.equal(late._reviewEarnings.totals.grandTotal,9000);checks++;
 console.log(`PASS earnings UI: ${checks} deferred/network/success/session checks`);
})().catch(e=>{console.error(e);process.exitCode=1;});
