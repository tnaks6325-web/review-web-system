/* ══════════════════════════════════════════════════════════
   인애드 등록 JS — index.html (한 화면 통합 ver.)
   ══════════════════════════════════════════════════════════ */

/* ── 전화번호 포커스 스타일 ── */
function regPhoneFocus(){var w=document.getElementById('regPhoneWrap');if(w)w.style.borderColor='var(--p)';}
function regPhoneBlur(){var w=document.getElementById('regPhoneWrap');if(w)w.style.borderColor='#d1d5db';}

/* ── 숫자만 허용 + 4자리 자동 이동 ── */
function regPhoneInput(el,id){
  el.value=el.value.replace(/[^0-9]/g,'');
  if(id==='regPhone1'&&el.value.length===4){var n=document.getElementById('regPhone2');if(n)n.focus();}
  regClearError();
}

/* ── 이름 유효성: 자음/모음만 차단, 최소 2자 ── */
function isValidKoreanName(name){
  if(!name||name.length<2)return false;
  if(/^[ㄱ-ㅎ\s]+$/.test(name))return false;
  if(/^[ㅏ-ㅣ\s]+$/.test(name))return false;
  if(/^[ㄱ-ㅣ\s]+$/.test(name))return false;
  if(/^[0-9\s]+$/.test(name))return false;
  if(/^[^가-힣a-zA-Z0-9]+$/.test(name))return false;
  return true;
}

/* ── 에러 표시 / 숨김 ── */
function _regShowError(msg){
  var e=document.getElementById('regError'),t=document.getElementById('regErrorText');
  if(t)t.textContent=msg; if(e)e.style.display='';
}
function regClearError(){var e=document.getElementById('regError');if(e)e.style.display='none';}

/* ── 복사/카카오/등록하기 버튼 활성화 ── */
function _regEnableActions(){
  var cb=document.getElementById('regCopyBtn');
  if(cb){cb.disabled=false;cb.style.background='#d97706';}
  var kb=document.getElementById('regKakaoBtn');
  if(kb){kb.classList.remove('reg-kakao-disabled');}
  var sb=document.getElementById('regSubmitBtn');
  if(sb){sb.disabled=false;}
}
function _regDisableActions(){
  var cb=document.getElementById('regCopyBtn');
  if(cb){cb.disabled=true;cb.style.background='';}
  var kb=document.getElementById('regKakaoBtn');
  if(kb){kb.classList.add('reg-kakao-disabled');}
  var sb=document.getElementById('regSubmitBtn');
  if(sb){sb.disabled=true;}
}

/* ── 결과 배너 ── */
function _regSetBanner(type,text){
  var banner=document.getElementById('regResultBanner');
  var rtext=document.getElementById('regResultText');
  if(banner){banner.className=type==='ok'?'reg-result-banner ok':'reg-result-banner dup';banner.style.display='flex';}
  if(rtext)rtext.textContent=text;
}

/* ── 발송 메시지 복사 ── */
function regCopyMsg(){
  var msg=window._regSendMsg||'';
  if(!msg){_regShowError('먼저 동의하기 버튼을 눌러주세요.');return;}
  var btn=document.getElementById('regCopyBtn');
  var _ok=function(){
    if(btn){btn.innerHTML='<i class="fas fa-check"></i> 복사 완료!';btn.style.background='#16a34a';}
    setTimeout(function(){if(btn){btn.innerHTML='<i class="fas fa-copy"></i> 메시지 복사하기';btn.style.background='#d97706';}},2500);
  };
  var _fb=function(){
    var ta=document.createElement('textarea');ta.value=msg;
    ta.style.cssText='position:fixed;opacity:0;top:0;left:0;width:1px;height:1px';
    document.body.appendChild(ta);ta.focus();ta.select();
    try{document.execCommand('copy');}catch(e){}
    document.body.removeChild(ta);_ok();
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(msg).then(_ok).catch(_fb);}
  else{_fb();}
}

/* ── 카카오 버튼 클릭 ── */
function regKakaoClick(e){
  var kb=document.getElementById('regKakaoBtn');
  if(kb&&kb.classList.contains('reg-kakao-disabled')){
    e.preventDefault();_regShowError('먼저 동의하기 버튼을 눌러주세요.');return false;
  }
  regSaveStateBeforeKakao();return true;
}

/* ── 카카오 이동 전 상태 저장 ── */
function regSaveStateBeforeKakao(){
  try{localStorage.setItem('_regRestoreState',JSON.stringify({
    done:true,msg:window._regSendMsg||'',
    name:window._regName||'',phone1:window._regPhone1||'',phone2:window._regPhone2||'',
    ts:Date.now()
  }));}catch(e){}
}

/* ── 모달 열기 ── */
function openRegisterModal(){
  try{localStorage.removeItem('_regRestoreState');}catch(e){}
  var modal=document.getElementById('registerModal');
  if(!modal){if(typeof showToast==='function')showToast('등록 창을 찾을 수 없습니다.','error');return;}

  ['regName','regPhone1','regPhone2'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  var wrap=document.getElementById('regPhoneWrap');if(wrap)wrap.style.borderColor='#d1d5db';
  regClearError();

  var agreeBtn=document.getElementById('regAgreeBtn');
  if(agreeBtn){agreeBtn.disabled=false;agreeBtn.innerHTML='<i class="fas fa-check-circle"></i> 동의하기';}

  var banner=document.getElementById('regResultBanner');if(banner)banner.style.display='none';
  _regDisableActions();
  window._regSendMsg='';window._regName='';window._regPhone1='';window._regPhone2='';

  modal.style.display='flex';
  setTimeout(function(){var n=document.getElementById('regName');if(n)n.focus();},150);
}

/* ── 모달 닫기 ── */
function closeRegisterModal(){
  var modal=document.getElementById('registerModal');
  if(modal)modal.style.display='none';
  try{localStorage.removeItem('_regRestoreState');}catch(e){}
}
function closeRegisterSuccess(){closeRegisterModal();}

/* ── 카카오 복귀 복원 ── */
function regCheckRestoreState(){
  try{
    var raw=localStorage.getItem('_regRestoreState');
    if(!raw)return;
    var s=JSON.parse(raw);
    if(!s||!s.done)return;
    if(Date.now()-s.ts>5*60*1000){localStorage.removeItem('_regRestoreState');return;}

    window._regSendMsg=s.msg||'';
    window._regName=s.name||'';
    window._regPhone1=s.phone1||'';
    window._regPhone2=s.phone2||'';
    _regEnableActions();
    var cb=document.getElementById('regCopyBtn');
    if(cb){cb.innerHTML='<i class="fas fa-copy"></i> 메시지 복사하기';cb.style.background='#d97706';}
    // 등록 완료 여부는 모름 → 배너는 숨김 유지, 등록하기만 활성화

    var modal=document.getElementById('registerModal');
    if(modal)modal.style.display='flex';
    localStorage.removeItem('_regRestoreState');
  }catch(e){}
}

/* ══ ① 동의하기: 입력 검증 + 메시지 생성 + 복사/카카오/등록하기 활성화 ══ */
window.regAgree = function(){
  regClearError();

  var name  =(document.getElementById('regName')   ?document.getElementById('regName').value  :'').trim();
  var phone1=(document.getElementById('regPhone1') ?document.getElementById('regPhone1').value:'').replace(/[^0-9]/g,'');
  var phone2=(document.getElementById('regPhone2') ?document.getElementById('regPhone2').value:'').replace(/[^0-9]/g,'');

  if(!name){_regShowError('이름을 입력해주세요.');var nEl=document.getElementById('regName');if(nEl)nEl.focus();return;}
  if(!isValidKoreanName(name)){_regShowError('올바른 이름을 입력해주세요. (자음·모음만 불가, 최소 2자)');var nEl2=document.getElementById('regName');if(nEl2)nEl2.focus();return;}
  if(phone1.length!==4){_regShowError('전화번호 앞 4자리를 모두 입력해주세요.');var p1El=document.getElementById('regPhone1');if(p1El)p1El.focus();return;}
  if(phone2.length!==4){_regShowError('전화번호 뒤 4자리를 모두 입력해주세요.');var p2El=document.getElementById('regPhone2');if(p2El)p2El.focus();return;}

  // 저장
  window._regName=name;window._regPhone1=phone1;window._regPhone2=phone2;

  // 발송 메시지 생성
  var pad=function(n){return String(n).padStart(2,'0');};
  var now=new Date();
  var regTime=now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())+' '+pad(now.getHours())+':'+pad(now.getMinutes());
  var siteUrl=location.href.split('?')[0].split('#')[0];
  window._regSendMsg=
    '인애드 리뷰어 등록 및\n'+
    '작업알림 수신동의 합니다.\n'+
    '이름: '+name+'\n'+
    '전화번호: 010-'+phone1+'-'+phone2+'\n'+
    '등록일시: '+regTime+'\n'+
    '리뷰웹으로 돌아가서 등록마치기.\n'+
    siteUrl;

  // 복사·카카오·등록하기 활성화
  _regEnableActions();
  var cb=document.getElementById('regCopyBtn');
  if(cb){cb.innerHTML='<i class="fas fa-copy"></i> 메시지 복사하기';cb.style.background='#d97706';}

  // 동의하기 버튼 완료 표시 (재클릭 가능하게 유지)
  var agreeBtn=document.getElementById('regAgreeBtn');
  if(agreeBtn){agreeBtn.innerHTML='<i class="fas fa-check-circle"></i> 동의 완료 (재입력 가능)';}

  // 등록하기 버튼으로 스크롤
  var sb=document.getElementById('regSubmitBtn');
  if(sb){setTimeout(function(){sb.scrollIntoView({behavior:'smooth',block:'nearest'});},100);}
};

/* ══ ② 등록하기: GAS 호출 → DB 저장 ══ */
window.submitRegister = async function(){
  if(window._registerInProgress)return;

  var name  =window._regName||'';
  var phone1=window._regPhone1||'';
  var phone2=window._regPhone2||'';

  if(!name||phone1.length!==4||phone2.length!==4){
    _regShowError('동의하기 버튼을 먼저 눌러주세요.');return;
  }

  window._registerInProgress=true;
  var btn=document.getElementById('regSubmitBtn');
  var _reset=function(){
    window._registerInProgress=false;
    if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-user-plus"></i> 등록하기';}
  };
  if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> 등록 중...';}

  var phone='010'+phone1+phone2;
  var sheetId=(window._currentCampaign&&window._currentCampaign.sheetId)||'';
  var payload={action:'registerReviewer',name:name,phone:phone,consent:'true',sheetId:sheetId};
  try{
    var data;
    try{data=await gasPost(payload);}catch(e1){try{data=await gasGet(payload);}catch(e2){throw new Error('서버 연결 실패');}}
    if(!data)throw new Error('서버 응답이 없습니다.');

    if(data.error){
      _regSetBanner('dup',data.isDuplicate?'중복된 전화번호입니다. (중복번호 등록불가)':(data.error||'등록 실패'));
      _reset();return;
    }

    _regSetBanner('ok','정상 등록 되었습니다!');
    if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-check"></i> 등록 완료';}
    window._registerInProgress=false;
    if(typeof showToast==='function')showToast(name+'님 등록 완료!','success');

  }catch(err){
    _regShowError('오류: '+(err&&err.message?err.message:String(err)));
    _reset();
  }
};

/* ── DOMContentLoaded ── */
document.addEventListener('DOMContentLoaded',function(){
  var nameEl=document.getElementById('regName');
  if(nameEl)nameEl.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var p=document.getElementById('regPhone1');if(p)p.focus();}});
  var p2El=document.getElementById('regPhone2');
  if(p2El)p2El.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();window.regAgree();}});
  regCheckRestoreState();
});
