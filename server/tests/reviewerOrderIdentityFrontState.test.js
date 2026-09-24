'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../frontend/js/search-app.js'),'utf8');
function fn(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);const ends=['\nfunction ','\nasync function '].map(x=>source.indexOf(x,start+1)).filter(x=>x>=0);return (source.slice(start-6,start)==='async '?'async ':'')+source.slice(start,Math.min(...ends));}
function harness(){
 const elements={};function el(value=''){const classes=new Set();return {value,style:{},dataset:{},innerHTML:'',textContent:'',disabled:false,readOnly:false,parentElement:null,events:{},classList:{add:(...a)=>a.forEach(x=>classes.add(x)),remove:(...a)=>a.forEach(x=>classes.delete(x)),toggle:(x,on)=>on?classes.add(x):classes.delete(x),contains:x=>classes.has(x)},focus(){this.focused=true},scrollIntoView(){this.scrolled=true},getBoundingClientRect(){return {top:100}},removeAttribute(){},setAttribute(){},addEventListener(k,f){this.events[k]=f}};}
 for(const [f,v] of Object.entries({recipient:'김민수',phone:'010-1234-5678',address:'서울 등록길 502호',price:'39900'}))elements['card_'+f]=el(v);
 elements.card_identityStatus=el();elements.card_imgInput=el('old.jpg');elements.card_imgInput.click=function(){this.clicked=(this.clicked||0)+1};elements.orderIdentityAction=el();elements.btnOrderFormSubmit=el();
 let submissions=0,requests=0;const ctx={_orderCardIds:['card'],_EMBED_CTX:{app:'test'},_PREVIEW_MODE:false,_BATCH:false,API_BASE_URL:'https://invalid.example',_activeIdentityContext:{selectedIdentity:{name:'김타계',phone:'010-1234-5678',address:'서울 등록길 502호'}},_orderInfoSuggestions:[{id:'a'.repeat(64),recipient:'김민수',phone:'010-1234-5678',address:'부산 배송길 1508호',useCount:3}],_cardAiState:{card:{analysisRequestId:1,extracted:{recipient:'김민수',phone:'010-1234-5678',address:'서울 등록길 502호',price:'39900'},extractToken:'capture',lastBase64:'image',reviewToken:'review'}},document:{getElementById:id=>elements[id]||null},location:{origin:'https://invalid.example'},scrollY:0,_safeText:v=>String(v).replace(/</g,'&lt;').replace(/>/g,'&gt;'),_getAuthHeaders:()=>({}),_reviewerIdentityRequestBody:x=>x,_loadOrderIdentityContext:async()=>{},_restoreSavedInfoInputHandler:()=>{},_ofClearError:()=>{},_embedSaveForm:()=>{},formatPhoneInput:()=>{},showToast:()=>{},confirm:()=>{throw Error('unexpected confirmation dialog')},confirmOrderSubmit:()=>{submissions++},fetch:async()=>{requests++;return {ok:true,json:async()=>({ok:true,approvalToken:'approved'})}}};ctx.window=ctx;ctx.parent=ctx;
 vm.createContext(ctx);for(const name of ['_identityAddressDifference','_identityIssues','_pointToIdentityField','_purchaseIdentityTarget','_purchasePrimaryAction','_syncSubmissionIdentityAction','_retrySubmissionIdentity','_identityNeedsNewCapture','_identityMismatchNotice','_renderIdentityMatchState','_hasIdentityMask','_cardIdentityForm','_savedIdentitySelections','_manualConfirmIdentity','_invalidateIdentityApproval','_applyOrderInfoSuggestion','_prepareIdentityApprovals','applyCardAiResult'])vm.runInContext(fn(name),ctx);
 return {ctx,elements,counts:()=>({submissions,requests})};
}
(async()=>{
 const {ctx,elements,counts}=harness();const st=ctx._cardAiState.card;
 st.approvalToken='automatic';ctx._renderIdentityMatchState('card','MATCH',[],false);
 assert.equal(elements.btnOrderFormSubmit.textContent,'제출');assert.equal(elements.orderIdentityAction.style.display,'none');ctx._purchasePrimaryAction();assert.equal(counts().submissions,1);
 st.approvalToken='automatic';ctx._applyOrderInfoSuggestion({dataset:{cid:'card',suggestionId:'a'.repeat(64)}});assert.equal(elements.card_recipient.value,'김민수');assert.equal(elements.card_phone.value,'010-1234-5678');assert.equal(elements.card_address.value,'부산 배송길 1508호');assert.equal(st.approvalToken,'');
 console.log('PASS 과거 주문정보 조합 3개 필드 동시 적용 / 기존 명의승인 폐기');
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
 {
 // 실사고 2026-09-24: 다른 저장 명의와 일치(MISMATCH) → [제출]이 같은 캡처를 재분석만 반복(최대 48회)·참여 만료.
 const {ctx:c,elements:e,counts:k}=harness();const s2=c._cardAiState.card;s2.reviewToken='';let reanalyzed=0;c._retryCardAi=()=>{reanalyzed++};
 s2.identityChecks=[{field:'recipient',status:'mismatch',reason:'이름 불일치'}];s2.identityReasonCodes=['insufficient_independent_matches','other_owner_identity_matches'];
 c._renderIdentityMatchState('card','MISMATCH',['이름 불일치'],false);
 assert.equal(e.btnOrderFormSubmit.textContent,'다른 캡처 올리기');
 assert(e.card_identityStatus.innerHTML.includes('다른 명의의 주문 캡처로 보입니다'));assert(e.card_identityStatus.innerHTML.includes('김타계'));
 assert(e.card_identityStatus.innerHTML.includes('다른 캡처 올리기'));assert(!e.card_identityStatus.innerHTML.includes('캡처 다시 분석하기'));
 c._purchasePrimaryAction();assert.equal(reanalyzed,0);assert.equal(e.card_imgInput.clicked,1);assert.equal(e.card_imgInput.value,'');assert.equal(k().submissions,0);assert(!e.card_recipient.focused);
 s2.identityReasonCodes=['selected_identity_conflict'];c._renderIdentityMatchState('card','MISMATCH',['이름 불일치'],false);
 assert(e.card_identityStatus.innerHTML.includes('참여 명의와 맞지 않습니다'));assert.equal(e.btnOrderFormSubmit.textContent,'다른 캡처 올리기');
 s2.identityReasonCodes=['x<b>'];c._activeIdentityContext.selectedIdentity.name='<img>';c._renderIdentityMatchState('card','MISMATCH',[],false);assert(!e.card_identityStatus.innerHTML.includes('<img>'));
 console.log('PASS 명의 불일치 = 재분석 반복 금지 · 사유 안내 · 다른 캡처 선택');
 }
 {
 // nc 모드 2번(쿠팡) 카드: 안내 상자가 없어도 MISMATCH 가 기록돼 재분석 반복이 없어야 한다(코덱스 리뷰 P1).
 const {ctx:c,elements:e}=harness();delete e.card_identityStatus;const s3=c._cardAiState.card;s3.reviewToken='';let re=0;c._retryCardAi=()=>{re++};
 s3.identityReasonCodes=['other_owner_identity_matches'];c._renderIdentityMatchState('card','MISMATCH',[],false);
 assert.equal(s3.identityStatus,'MISMATCH');assert.equal(e.btnOrderFormSubmit.textContent,'다른 캡처 올리기');assert(e.orderIdentityAction.innerHTML.includes('다른 명의의 주문 캡처로 보입니다'));
 c._purchasePrimaryAction();assert.equal(re,0);assert.equal(e.card_imgInput.clicked,1);
 console.log('PASS 안내 상자 없는 카드(nc 쿠팡)도 불일치 기록 · 재분석 반복 금지');
 }
 for(const mask of ['*','＊','●','○','◯','◉','•','·','x','X']){const {ctx:c,elements:e}=harness();c._cardAiState.card.extracted={recipient:'김'+mask+'수'};c.applyCardAiResult('card');assert.equal(e.card_recipient.readOnly,false);}
 console.log('PASS 가림문자 10종 수정 가능');
})().catch(e=>{console.error(e);process.exitCode=1});
