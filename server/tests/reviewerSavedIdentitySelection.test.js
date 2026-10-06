'use strict';
// 결정 207: 캡처 재분석·삭제로 "골랐음" 기록을 비우면 목록 칸 글자도 되돌린다 /
// 수취인 저장정보를 고르면 이미 같은 값으로 적힌 연락처·주소도 "골랐음"으로 함께 기록한다.
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../frontend/js/search-app.js'),'utf8');
function fn(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);const ends=['\nfunction ','\nasync function ','\nwindow.'].map(x=>source.indexOf(x,start+1)).filter(x=>x>=0);return source.slice(start,Math.min(...ends));}
function block(startText,endText){const s=source.indexOf(startText);assert(s>=0,startText);const e=source.indexOf(endText,s);assert(e>s,endText);return source.slice(s,e);}
function el(value=''){return {value,textContent:'',disabled:false,dataset:{},classList:{remove(){}},removeAttribute(){},style:{},parentElement:null,querySelector(sel){return this.children?.[sel]||null},closest(){return this.wrap||null}};}
function harness(fields){
  const elements={};
  for(const [f,v] of Object.entries(fields))elements['card_'+f]=el(v);
  for(const f of ['recipient','phone','address']){const label=el();label.textContent='김민수 · 본계정 — 이전 선택';const trigger=el();trigger.children={'.of-saved-info-trigger-label':label};const wrap=el();wrap.children={'.of-saved-info-trigger':trigger,'.of-saved-info-trigger-label':label};elements['card_'+f+'SavedInfo']=wrap;}
  const identity={identityKey:'self:1',name:'김민수',phone:'010-1234-5678',address:'서울 등록길 502호',type:'self'};
  const ctx={_cardAiState:{card:{savedIdentitySelections:{recipient:'self:1',phone:'self:1'}}},_activeIdentityContext:{selectedIdentity:identity},_scopedSavedOrderIdentities:()=>[identity],
    document:{getElementById:id=>elements[id]||null},formatPhoneInput(){},_restoreSavedInfoInputHandler(){},_ofClearError(){},_invalidateIdentityApproval(){},_closeSavedInfoDropdowns(){},
    _addrState:()=>({}),_syncAddressTools(){},_embedSaveForm(){},_syncSubmissionIdentityAction(){},showToast(){}};
  ctx.window=ctx;vm.createContext(ctx);
  vm.runInContext(block('const _SAVED_ORDER_INFO_FIELDS','\n\n'),ctx);
  for(const name of ['_hasIdentityMask','_addrKey','_resetSavedIdentityPickerLabels','_clearSavedIdentitySelection','_savedIdentitySelections','_sameSavedIdentityValue'])vm.runInContext(fn(name),ctx);
  vm.runInContext(block('window._applySavedOrderInfo = function','\nfunction _loadDismissedOrderInfoIds'),ctx);
  return {ctx,elements,identity};
}
function pick(ctx,elements,field){const option=el();option.dataset={cid:'card',field,savedIdentityKey:'self:1'};option.textContent='김민수 · 본계정 — 선택';option.wrap=elements['card_'+field+'SavedInfo'];ctx._applySavedOrderInfo(option);}

{ // 1) 기록을 비우면 칸 글자도 "내 정보에서 선택"으로 되돌린다(비활성 칸은 건드리지 않음)
  const {ctx,elements}=harness({recipient:'김민수',phone:'010-1234-5678',address:'서울 등록길 502호'});
  elements.card_addressSavedInfo.children['.of-saved-info-trigger'].disabled=true;
  ctx._resetSavedIdentityPickerLabels('card');
  assert.equal(elements.card_recipientSavedInfo.children['.of-saved-info-trigger-label'].textContent,'내 정보에서 선택');
  assert.equal(elements.card_phoneSavedInfo.children['.of-saved-info-trigger-label'].textContent,'내 정보에서 선택');
  assert.equal(elements.card_addressSavedInfo.children['.of-saved-info-trigger-label'].textContent,'김민수 · 본계정 — 이전 선택');
  // 재분석·삭제 두 곳 모두 기록을 비우는 자리에서 글자도 되돌린다
  assert(/st\.savedIdentitySelections = \{\};\n  _resetSavedIdentityPickerLabels\(cid\);/.test(fn('_callCardExtractAi')));
  assert(/st\.savedIdentitySelections = \{\}; \}\n  _resetSavedIdentityPickerLabels\(cid\);/.test(fn('removeCardImg')));
  console.log('PASS 재분석·삭제 시 목록 칸 글자도 되돌림');
}
{ // 2) 연락처·주소가 이미 같은 저장값이면 수취인 하나만 골라도 셋 다 기록된다(값은 그대로)
  const {ctx,elements}=harness({recipient:'김*수',phone:'01012345678',address:'서울 등록길, 502호'});
  ctx._cardAiState.card.savedIdentitySelections={};
  pick(ctx,elements,'recipient');
  assert.deepStrictEqual({...ctx._savedIdentitySelections('card')},{recipient:'self:1',phone:'self:1',address:'self:1'});
  assert.equal(elements.card_recipient.value,'김민수');assert.equal(elements.card_phone.value,'01012345678');assert.equal(elements.card_address.value,'서울 등록길, 502호');
  console.log('PASS 같은 값이면 수취인 선택으로 연락처·주소도 기록(값 유지)');
}
{ // 3) 다른 값은 기록하지 않고 바꾸지도 않는다(본인 확인을 느슨하게 만들지 않음)
  const {ctx,elements}=harness({recipient:'김*수',phone:'010-9999-5678',address:'부산 배송길 1508호'});
  ctx._cardAiState.card.savedIdentitySelections={};
  pick(ctx,elements,'recipient');
  assert.deepStrictEqual({...ctx._savedIdentitySelections('card')},{recipient:'self:1',phone:'',address:''});
  assert.equal(elements.card_phone.value,'010-9999-5678');assert.equal(elements.card_address.value,'부산 배송길 1508호');
  console.log('PASS 다른 값은 기록·변경하지 않음');
}
{ // 4) 가림 값은 종전대로 저장값으로 채우고 기록한다
  const {ctx,elements}=harness({recipient:'김*수',phone:'010-****-5678',address:''});
  ctx._cardAiState.card.savedIdentitySelections={};
  pick(ctx,elements,'recipient');
  assert.equal(elements.card_phone.value,'010-1234-5678');assert.equal(elements.card_address.value,'서울 등록길 502호');
  assert.deepStrictEqual({...ctx._savedIdentitySelections('card')},{recipient:'self:1',phone:'self:1',address:'self:1'});
  console.log('PASS 가림·빈 값은 종전대로 채우고 기록');
}
