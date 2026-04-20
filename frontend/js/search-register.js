/* ══════════════════════════════════════════════════════════
   인애드 등록 JS — search.html (한 화면 통합 ver.)
   ══════════════════════════════════════════════════════════ */

function regPhoneFocus(){var w=document.getElementById('regPhoneWrap');if(w)w.style.borderColor='var(--p)';}
function regPhoneBlur(){var w=document.getElementById('regPhoneWrap');if(w)w.style.borderColor='#d1d5db';}

function regPhoneInput(el,id){
  el.value=el.value.replace(/[^0-9]/g,'');
  if(id==='regPhone1'&&el.value.length===4){var n=document.getElementById('regPhone2');if(n)n.focus();}
  regClearError();
}

function isValidKoreanName(name){
  if(!name||name.length<2)return false;
  if(/^[ㄱ-ㅎ\s]+$/.test(name))return false;
  if(/^[ㅏ-ㅣ\s]+$/.test(name))return false;
  if(/^[ㄱ-ㅣ\s]+$/.test(name))return false;
  if(/^[0-9\s]+$/.test(name))return false;
  if(/^[^가-힣a-zA-Z0-9]+$/.test(name))return false;
  return true;
}

/* ── 등록 단계 상태 플래그 ── */
var _regStep = { agreed: false, copied: false, kakaoed: false };

function _regUpdateProgress() {
  var steps = [_regStep.agreed, _regStep.copied, _regStep.kakaoed];
  var done  = steps.filter(Boolean).length;
  var pct   = Math.round(done / 3 * 100);

  // 진행 바
  var wrap  = document.getElementById('regProgressWrap');
  var bar   = document.getElementById('regProgressBar');
  var label = document.getElementById('regProgressLabel');
  if (wrap)  wrap.style.display  = done > 0 ? '' : 'none';
  if (bar)   bar.style.width     = pct + '%';
  if (label) { label.style.display = done > 0 ? '' : 'none'; label.textContent = '진행 ' + done + '/3 단계 완료'; }

  // STEP 2 완료 표시
  var h2 = document.getElementById('stepHeader2'), c2 = document.getElementById('stepCheck2');
  if (h2) h2.classList.toggle('step-done', _regStep.copied);
  if (c2) c2.style.display = _regStep.copied ? '' : 'none';

  // STEP 3 완료 표시
  var h3 = document.getElementById('stepHeader3'), c3 = document.getElementById('stepCheck3');
  if (h3) h3.classList.toggle('step-done', _regStep.kakaoed);
  if (c3) c3.style.display = _regStep.kakaoed ? '' : 'none';

  // 등록 버튼 활성화 여부
  var allDone = _regStep.agreed && _regStep.copied && _regStep.kakaoed;
  var sb = document.getElementById('regSubmitBtn');
  if (sb) sb.disabled = !allDone;
}

function _regShowError(msg) {
  var e=document.getElementById('regError'),t=document.getElementById('regErrorText');
  if(t)t.textContent=msg;if(e)e.style.display='';
}
function regClearError(){var e=document.getElementById('regError');if(e)e.style.display='none';}

function _regEnableActions(){
  var cb=document.getElementById('regCopyBtn');
  if(cb){cb.disabled=false;cb.style.background='#d97706';}
  var kb=document.getElementById('regKakaoBtn');
  if(kb){kb.classList.remove('reg-kakao-disabled');}
  // 등록 버튼은 3단계 완료 후에만 활성화 (_regUpdateProgress 가 담당)
}
function _regDisableActions(){
  var cb=document.getElementById('regCopyBtn');
  if(cb){cb.disabled=true;cb.style.background='';}
  var kb=document.getElementById('regKakaoBtn');
  if(kb){kb.classList.add('reg-kakao-disabled');}
  var sb=document.getElementById('regSubmitBtn');
  if(sb){sb.disabled=true;}
  // 플래그 초기화
  _regStep.agreed=false;_regStep.copied=false;_regStep.kakaoed=false;
  _regUpdateProgress();
}

function _regSetBanner(type,text){
  var banner=document.getElementById('regResultBanner');
  var rtext=document.getElementById('regResultText');
  if(banner){banner.className=type==='ok'?'reg-result-banner ok':'reg-result-banner dup';banner.style.display='flex';}
  if(rtext)rtext.textContent=text;
}

function regCopyMsg(){
  var msg=window._regSendMsg||'';
  if(!msg){_regShowError('먼저 동의하기 버튼을 눌러주세요.');return;}
  var btn=document.getElementById('regCopyBtn');
  var _ok=function(){
    _regStep.copied=true;
    _regUpdateProgress();
    if(btn){btn.innerHTML='<i class="fas fa-check"></i> 복사 완료!';btn.style.background='#16a34a';}
    // 복사 완료 후 버튼 텍스트 유지 (재복사 가능하되 완료 표시 유지)
    setTimeout(function(){if(btn){btn.innerHTML='<i class="fas fa-check"></i> 복사됨 (재복사 가능)';btn.style.background='#16a34a';}},2500);
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

function regKakaoClick(e){
  var kb=document.getElementById('regKakaoBtn');
  if(kb&&kb.classList.contains('reg-kakao-disabled')){
    e.preventDefault();_regShowError('먼저 동의하기 버튼을 눌러주세요.');return false;
  }
  // 카카오 버튼 클릭 완료 표시
  _regStep.kakaoed=true;
  _regUpdateProgress();
  if(kb){kb.innerHTML='<i class="fas fa-check"></i> 발송 완료 (이 페이지로 돌아오세요)';}
  regSaveStateBeforeKakao();return true;
}

function regSaveStateBeforeKakao(){
  try{localStorage.setItem('_regRestoreState',JSON.stringify({done:true,msg:window._regSendMsg||'',ts:Date.now()}));}catch(e){}
}

function openRegisterModal(){
  try{localStorage.removeItem('_regRestoreState');}catch(e){}
  var modal=document.getElementById('registerModal');
  if(!modal){if(typeof showToast==='function')showToast('등록 창을 찾을 수 없습니다.','error');return;}

  ['regName','regPhone1','regPhone2'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  var wrap=document.getElementById('regPhoneWrap');if(wrap)wrap.style.borderColor='#d1d5db';
  regClearError();

  // ★ 이름 입력란에 검색창에서 입력한 이름 자동 세팅
  var nameInputVal=(document.getElementById('nameInput')||{}).value||'';
  if(nameInputVal.trim()){
    var regNameEl=document.getElementById('regName');
    if(regNameEl){ regNameEl.value=nameInputVal.trim(); }
  }

  var agreeBtn=document.getElementById('regAgreeBtn');
  if(agreeBtn){agreeBtn.disabled=false;agreeBtn.innerHTML='<i class="fas fa-check-circle"></i> 동의하기';}

  var banner=document.getElementById('regResultBanner');
  if(banner)banner.style.display='none';

  _regDisableActions();
  window._regSendMsg='';window._regName='';window._regPhone1='';window._regPhone2='';
  // 진행 바 초기화
  var ww=document.getElementById('regProgressWrap'),ll=document.getElementById('regProgressLabel');
  if(ww)ww.style.display='none';if(ll)ll.style.display='none';
  var sw=document.getElementById('regStepsWarn');if(sw){sw.className='reg-steps-warn';sw.innerHTML='';}  

  modal.style.display='flex';
  setTimeout(function(){var n=document.getElementById('regName');if(n)n.focus();},150);
}

function closeRegisterModal(){
  var modal=document.getElementById('registerModal');
  if(modal)modal.style.display='none';
  try{localStorage.removeItem('_regRestoreState');}catch(e){}
}

/* ══ 동의하기: 입력 검증 + 메시지 생성 + 복사/카카오/등록하기 활성화 ══ */
window.regAgree = function(){
  regClearError();
  var name  =(document.getElementById('regName')   ?document.getElementById('regName').value  :'').trim();
  var phone1=(document.getElementById('regPhone1') ?document.getElementById('regPhone1').value:'').replace(/[^0-9]/g,'');
  var phone2=(document.getElementById('regPhone2') ?document.getElementById('regPhone2').value:'').replace(/[^0-9]/g,'');

  if(!name){_regShowError('이름을 입력해주세요.');var nEl=document.getElementById('regName');if(nEl)nEl.focus();return;}
  if(!isValidKoreanName(name)){_regShowError('올바른 이름을 입력해주세요. (자음·모음만 불가, 최소 2자)');var nEl2=document.getElementById('regName');if(nEl2)nEl2.focus();return;}
  if(phone1.length!==4){_regShowError('전화번호 앞 4자리를 모두 입력해주세요.');var p1El=document.getElementById('regPhone1');if(p1El)p1El.focus();return;}
  if(phone2.length!==4){_regShowError('전화번호 뒤 4자리를 모두 입력해주세요.');var p2El=document.getElementById('regPhone2');if(p2El)p2El.focus();return;}

  window._regName=name;window._regPhone1=phone1;window._regPhone2=phone2;

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

  _regStep.agreed=true;
  _regStep.copied=false;
  _regStep.kakaoed=false;
  _regUpdateProgress();

  _regEnableActions();
  var cb=document.getElementById('regCopyBtn');
  if(cb){cb.innerHTML='<i class="fas fa-copy"></i> 메시지 복사하기';cb.style.background='#d97706';}

  var agreeBtn=document.getElementById('regAgreeBtn');
  if(agreeBtn){agreeBtn.innerHTML='<i class="fas fa-check-circle"></i> 동의 완료 (재입력 가능)';}

  var sb=document.getElementById('regSubmitBtn');
  if(sb){setTimeout(function(){sb.scrollIntoView({behavior:'smooth',block:'nearest'});},100);}
};

function regCheckRestoreState(){
  try{
    var raw=localStorage.getItem('_regRestoreState');
    if(!raw)return;
    var s=JSON.parse(raw);
    if(!s||!s.done)return;
    if(Date.now()-s.ts>5*60*1000){localStorage.removeItem('_regRestoreState');return;}

    window._regSendMsg=s.msg||'';
    // 카카오 복귀 → 발송 완료 플래그 set
    _regStep.agreed=true;_regStep.copied=true;_regStep.kakaoed=true;
    _regEnableActions();
    _regUpdateProgress();
    var cb=document.getElementById('regCopyBtn');
    if(cb){cb.innerHTML='<i class="fas fa-check"></i> 복사됨 (재복사 가능)';cb.style.background='#16a34a';}
    var kb=document.getElementById('regKakaoBtn');
    if(kb){kb.innerHTML='<i class="fas fa-check"></i> 발송 완료 (이 페이지로 돌아오세요)';}

    var modal=document.getElementById('registerModal');
    if(modal)modal.style.display='flex';
    localStorage.removeItem('_regRestoreState');
  }catch(e){}
}

window.submitRegister = async function(){
  if(window._registerInProgress)return;

  // 동의하기 체크
  var name  =window._regName||'';
  var phone1=window._regPhone1||'';
  var phone2=window._regPhone2||'';

  if(!name||phone1.length!==4||phone2.length!==4){
    _regShowError('동의하기 버튼을 먼저 눌러주세요.');return;
  }

  // 3단계 미완료 체크
  var missing=[];
  if(!_regStep.agreed)  missing.push('① 개인정보 동의하기');
  if(!_regStep.copied)  missing.push('② 발송 메시지 복사하기');
  if(!_regStep.kakaoed) missing.push('③ 최초 메시지 1회 발송하기');

  if(missing.length>0){
    var sw=document.getElementById('regStepsWarn');
    if(sw){
      sw.innerHTML='<strong>⚠ 아래 단계를 먼저 완료해주세요:</strong><ul>'+missing.map(function(m){return '<li>'+m+'</li>';}).join('')+'</ul>';
      sw.classList.add('show');
      setTimeout(function(){sw.scrollIntoView({behavior:'smooth',block:'nearest'});},50);
    }
    return;
  }

  window._registerInProgress=true;
  var btn=document.getElementById('regSubmitBtn');
  var _reset=function(){
    window._registerInProgress=false;
    if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-user-plus"></i> 등록하기';}
  };
  if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> 등록 중...';}

  var phone='010'+phone1+phone2;
  regClearError();

  var sheetId=(window._orderFormCtx&&window._orderFormCtx.sheetId)||'';
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
    if(typeof showToast==='function')showToast(name+'님 등록 완료! 자동 로그인합니다.','success');

    // ★ v9.14: 소득정보 입력 시 백그라운드 저장
    var regIncomeName=(document.getElementById('regIncomeName')&&document.getElementById('regIncomeName').value||'').trim();
    var regJuminRaw=(document.getElementById('regJuminNo')&&document.getElementById('regJuminNo').value||'').replace(/[^0-9]/g,'');
    if(regIncomeName||regJuminRaw){
      var _phone8Reg=(phone1+phone2).slice(-8);
      var incomePayload={action:'saveIncomeInfo',phone8:_phone8Reg,incomeName:regIncomeName,jumin:regJuminRaw};
      (typeof gasPost==='function'?gasPost(incomePayload):Promise.reject())
        .catch(function(){return typeof gasGet==='function'?gasGet(incomePayload):Promise.resolve();})
        .then(function(r){if(r&&r.ok)console.log('[등록] 소득정보 저장 완료');})
        .catch(function(e){console.warn('[등록] 소득정보 저장 실패:',e&&e.message);});
    }

    // ★ 등록 완료 → 자동 로그인 + 조회 시작
    setTimeout(async function(){
      try{
        // 이름 입력란에 등록 이름 세팅
        var nameEl=document.getElementById('nameInput');
        if(nameEl) nameEl.value=name;
        // 세션 저장 (등록 직후 — phone8 포함하여 동명이인 구분)
        var _p8=(phone1+phone2).slice(-8);
        if(typeof _saveAuthSession==='function') _saveAuthSession(name,true,true,_p8);
        if(typeof _applyLoginUI==='function') _applyLoginUI(name);
        // 모달 닫기
        if(typeof closeRegisterModal==='function') closeRegisterModal();
        // 미등록 안내 숨기기
        var nrWrap=document.getElementById('notRegisteredWrap');
        if(nrWrap) nrWrap.style.display='none';
        // 검색 실행
        if(typeof doSearch==='function') await doSearch();
      }catch(e){ console.warn('[등록 후 자동검색]',e.message); }
    },1000);

  }catch(err){
    _regShowError('오류: '+(err&&err.message?err.message:String(err)));
    _reset();
  }
};

document.addEventListener('DOMContentLoaded',function(){
  var nameEl=document.getElementById('regName');
  if(nameEl)nameEl.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var p=document.getElementById('regPhone1');if(p)p.focus();}});
  var p2El=document.getElementById('regPhone2');
  if(p2El)p2El.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();window.regAgree();}});
  regCheckRestoreState();
});
