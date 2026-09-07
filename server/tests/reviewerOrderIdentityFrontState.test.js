'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../frontend/js/search-app.js'),'utf8');
function fn(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);const ends=['\nfunction ','\nasync function '].map(x=>source.indexOf(x,start+1)).filter(x=>x>=0);return (source.slice(start-6,start)==='async '?'async ':'')+source.slice(start,Math.min(...ends));}
function harness(){
 const elements={};function el(value=''){const classes=new Set();return {value,style:{},dataset:{},innerHTML:'',textContent:'',disabled:false,readOnly:false,parentElement:null,events:{},classList:{add:(...a)=>a.forEach(x=>classes.add(x)),remove:(...a)=>a.forEach(x=>classes.delete(x)),toggle:(x,on)=>on?classes.add(x):classes.delete(x),contains:x=>classes.has(x)},focus(){this.focused=true},scrollIntoView(){this.scrolled=true},getBoundingClientRect(){return {top:100}},removeAttribute(){},setAttribute(){},addEventListener(k,f){this.events[k]=f}};}
 for(const [f,v] of Object.entries({recipient:'김민수',phone:'010-1234-5678',address:'서울 등록길 502호',price:'39900'}))elements['card_'+f]=el(v);
 elements.card_identityStatus=el();elements.orderIdentityAction=el();elements.btnOrderFormSubmit=el();
 let submissions=0,requests=0;const ctx={_orderCardIds:['card'],_EMBED_CTX:{app:'test'},_PREVIEW_MODE:false,_BATCH:false,API_BASE_URL:'https://invalid.example',_activeIdentityContext:{selectedIdentity:{address:'서울 등록길 502호'}},_cardAiState:{card:{analysisRequestId:1,extracted:{recipient:'김민수',phone:'010-1234-5678',address:'서울 등록길 502호',price:'39900'},extractToken:'capture',lastBase64:'image',reviewToken:'review'}},document:{getElementById:id=>elements[id]||null},location:{origin:'https://invalid.example'},scrollY:0,_safeText:v=>String(v).replace(/</g,'&lt;').replace(/>/g,'&gt;'),_getAuthHeaders:()=>({}),_reviewerIdentityRequestBody:x=>x,_loadOrderIdentityContext:async()=>{},showToast:()=>{},confirm:()=>{throw Error('unexpected confirmation dialog')},confirmOrderSubmit:()=>{submissions++},fetch:async()=>{requests++;return {ok:true,json:async()=>({ok:true,approvalToken:'approved'})}}};ctx.window=ctx;ctx.parent=ctx;
 vm.createContext(ctx);for(const name of ['_identityAddressDifference','_identityIssues','_pointToIdentityField','_purchaseIdentityTarget','_purchasePrimaryAction','_syncSubmissionIdentityAction','_retrySubmissionIdentity','_renderIdentityMatchState','_hasIdentityMask','_cardIdentityForm','_manualConfirmIdentity','_invalidateIdentityApproval','_prepareIdentityApprovals','applyCardAiResult'])vm.runInContext(fn(name),ctx);
 return {ctx,elements,counts:()=>({submissions,requests})};
}
(async()=>{
 const {ctx,elements,counts}=harness();const st=ctx._cardAiState.card;
 st.approvalToken='automatic';ctx._renderIdentityMatchState('card','MATCH',[],false);
 assert.equal(elements.btnOrderFormSubmit.textContent,'제출');assert.equal(elements.orderIdentityAction.style.display,'none');ctx._purchasePrimaryAction();assert.equal(counts().submissions,1);
 elements.card_address.value='서울 배송길 1508호 <tag>';ctx._invalidateIdentityApproval('card');
 // 실제 주소 가림문자가 아닌 HTML escape 검증은 별도로 수행한다.
 assert(elements.card_identityStatus.innerHTML.includes('&lt;tag'));
 elements.card_address.value='서울 배송길 1508호';ctx._invalidateIdentityApproval('card');
 assert.equal(elements.btnOrderFormSubmit.textContent,'내 주문이 맞습니다');assert(!elements.orderIdentityAction.innerHTML.includes('_manualConfirmIdentity('));
 await ctx._purchasePrimaryAction();assert.equal(counts().requests,1);assert.equal(counts().submissions,1);assert.equal(elements.btnOrderFormSubmit.textContent,'제출');assert.equal(elements.btnOrderFormSubmit.disabled,false);ctx._purchasePrimaryAction();assert.equal(counts().submissions,2);
 console.log('PASS 정상 바로 제출 / 추가확인 단일 버튼 / 확인 후 별도 클릭으로 제출');
 st.approvalToken='';st.proofExtracted={...st.extracted,phone:'',price:''};elements.card_phone.value='';elements.card_price.value='';ctx._renderIdentityMatchState('card','REVIEW',[],true);
 assert.equal(ctx._identityIssues('card').filter(x=>x.edit).length,2);assert(elements.orderIdentityAction.innerHTML.includes('캡처에서 읽지 못했습니다'));ctx._purchasePrimaryAction();assert(elements.card_phone.focused);assert.equal(counts().requests,1);
 elements.card_phone.value='010-1234-5678';elements.card_price.value='39900';ctx._renderIdentityMatchState('card','REVIEW',[],true);
 let release;ctx.fetch=()=>new Promise(r=>{release=r});const pending=ctx._manualConfirmIdentity('card');assert(elements.btnOrderFormSubmit.disabled);elements.card_address.value='서울 수정길 1800호';release({ok:true,json:async()=>({ok:true,approvalToken:'stale'})});await pending;assert.equal(st.approvalToken,'');assert.equal(elements.btnOrderFormSubmit.textContent,'내 주문이 맞습니다');
 console.log('PASS 항목별 판독 누락 / 필드 이동 / 확인 도중 수정된 값에 오래된 승인 사용 금지');
 ctx.fetch=async()=>({ok:false,json:async()=>({ok:false,code:'IDENTITY_TOKEN_INVALID',error:'시간 만료'})});await ctx._manualConfirmIdentity('card');assert(!st.identityCanManual);assert(elements.orderIdentityAction.innerHTML.includes('캡처 다시 분석하기'));assert.equal(elements.btnOrderFormSubmit.disabled,false);
 console.log('PASS 만료된 확인은 재분석 안내 및 버튼 잠금 해제');
 for(const mask of ['*','＊','●','○','◯','◉','•','·','x','X']){const {ctx:c,elements:e}=harness();c._cardAiState.card.extracted={recipient:'김'+mask+'수'};c.applyCardAiResult('card');assert.equal(e.card_recipient.readOnly,false);}
 console.log('PASS 가림문자 10종 수정 가능');
})().catch(e=>{console.error(e);process.exitCode=1});
