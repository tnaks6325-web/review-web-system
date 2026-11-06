/* Dedicated bundle UI. Legacy NC and same-order second capture remain untouched. */
(function(root) {
  'use strict';
  const channels = ['naver','coupang'];
  const labels = {naver:'네이버',coupang:'쿠팡'};
  const fields = {orderNum:'주문번호',userId:'구매 아이디',recipient:'수취인',phone:'연락처',address:'배송주소',paidAmount:'결제금액'};
  const escape = v => String(v == null ? '' : v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function product(detail) { return detail?.selectedOption?.dualChannelProduct || detail?.workDetail?.dualChannelProduct || detail?.work_detail?.dualChannelProduct || null; }
  function createController(context, request, options={}) {
    const state = {context:{...context}, channels:{naver:{},coupang:{}}, purchases:{naver:{},coupang:{}}, bank:{}, bundleApprovalToken:'', busy:false, completed:false};
    let pending;
    let serverState=null,serverReady=!options.requireServerState;
    function idle() { if(state.busy) throw Error('처리 중입니다. 잠시 기다려주세요.'); }
    function rejectStale(error){
      if([401,403,409].includes(error?.status))for(const ch of channels){invalidate(ch);state.channels[ch].extractToken='';state.channels[ch].extractionToken='';}
      throw error;
    }
    function invalidate(channel) {
      state.bundleApprovalToken=''; state.completed=false;
      if(channel) {
        const s=state.channels[channel]; s.approvalToken=''; s.priorApprovalToken=''; s.reviewToken=''; s.stagedInput='';
        if(s.artifact){s.revision=s.artifact.revision+1;s.extractToken='';s.extractionToken='';}
        if(s.supplement){s.supplement.extractionToken='';s.supplement.stagedInput='';s.supplement.revision=s.supplement.artifact?s.supplement.artifact.revision+1:1;}
        delete state.purchases[channel].primaryArtifactId; delete state.purchases[channel].supplementArtifactId;
      }
    }
    function setValues(channel, values) { idle(); if(!channels.includes(channel)) throw Error('구매처를 확인해주세요.'); const changed=Object.keys(fields).some(k=>state.purchases[channel][k]!==values[k]); if(changed) invalidate(channel); state.purchases[channel]={...state.purchases[channel],...Object.fromEntries(Object.keys(fields).map(k=>[k,values[k]]))}; }
    function setBank(values) { idle(); state.bank=Object.fromEntries(['bank','account','depositor'].map(k=>[k,values[k]||''])); state.bundleApprovalToken=''; }
    const envelope = extra => ({...state.context,...extra});
    // Server projection is a CAS hint, never restored approval authority.
    function applyServerState(next) {
      const valid=next?.version===1&&String(next.campaignApplicationId)===String(context.campaignApplicationId)&&typeof next.conditionFingerprint==='string'&&!!next.conditionFingerprint&&typeof next.identityFingerprint==='string'&&!!next.identityFingerprint&&Array.isArray(next.artifacts)&&next.artifacts.every(a=>a&&typeof a.id==='string'&&a.id&&channels.includes(a.channel)&&['primary','supplement'].includes(a.role)&&Number.isSafeInteger(a.revision)&&a.revision>0)&&new Set(next.artifacts.map(a=>a.channel+':'+a.role)).size===next.artifacts.length;
      serverReady=!!valid;
      if(!valid){channels.forEach(invalidate);serverState=null;return;}
      const changed=serverState&&(serverState.conditionFingerprint!==next.conditionFingerprint||serverState.identityFingerprint!==next.identityFingerprint);
      for(const ch of channels){
        const s=state.channels[ch],a=next.artifacts.find(a=>a.channel===ch&&a.role==='primary'),supp=next.artifacts.find(a=>a.channel===ch&&a.role==='supplement');
        if(changed||s.artifact?.id!==a?.id||s.artifact?.revision!==a?.revision||s.supplement?.artifact?.id!==supp?.id||s.supplement?.artifact?.revision!==supp?.revision) {
          invalidate(ch);s.extractToken='';s.extractionToken='';s.artifact=a?{...a}:undefined;s.revision=a?a.revision+1:1;
          s.supplement={image:s.supplement?.image,artifact:supp?{...supp}:undefined,revision:supp?supp.revision+1:1};
        }
      }
      serverState=structuredClone(next);
    }
    function updateServerState(next){idle();applyServerState(next);}
    async function revalidate(){
      if(options.loadServerState){try{applyServerState(await options.loadServerState());}catch(e){applyServerState(null);throw e;}}
      if(!serverReady)throw Error('현재 사진 보관 상태를 확인하지 못했습니다. 동시진행 준비 중이거나 연결이 끊겼습니다. 입력은 유지됩니다. 다시 확인해주세요.');
      if(serverState?.committedOrderSubmissionId)throw Error('이미 접수된 구매입니다. 공고에서 참여현황을 다시 열어주세요.');
    }
    function exportDraft(){return {version:1,campaignId:context.campaignId,campaignApplicationId:context.campaignApplicationId,inputs:Object.fromEntries(channels.map(ch=>[ch,purchaseValues(state.purchases[ch])])),bank:{...state.bank}};}
    function restoreDraft(draft){
      idle();if(draft?.version!==1||String(draft.campaignId)!==String(context.campaignId)||String(draft.campaignApplicationId)!==String(context.campaignApplicationId)||!draft.inputs)return false;
      for(const ch of channels){invalidate(ch);setValues(ch,draft.inputs[ch]||{});state.channels[ch].image=null;}
      setBank(draft.bank||{});return true;
    }
    async function setImage(channel,image) { idle(); const previous=state.channels[channel].artifact, supplement=state.channels[channel].supplement; invalidate(channel); state.channels[channel]={image:image?{...image}:null,artifact:previous,revision:previous?previous.revision+1:1,supplement:supplement?{artifact:supplement.artifact,revision:supplement.artifact?supplement.artifact.revision+1:1}:undefined}; }
    async function setSupplementImage(channel,image) {
      idle(); const s=state.channels[channel];
      if(image&&!s.image) throw Error('첫 번째 사진을 먼저 선택해주세요.');
      const previous=s.supplement?.artifact;
      s.supplement={image:image?{...image}:null,artifact:previous,revision:previous?previous.revision+1:1};
      delete state.purchases[channel].supplementArtifactId; state.bundleApprovalToken='';state.completed=false;
      s.stagedInput=JSON.stringify(state.purchases[channel]);
    }
    const purchaseValues = p => Object.fromEntries(Object.keys(fields).map(k=>[k,p[k]]));
    async function stageSupplement(channel) {
      idle();state.busy=true;
      const s=state.channels[channel],p=state.purchases[channel];
      try {
        await revalidate();
        const supp=s.supplement;
        if(!supp?.image)throw Error('보충사진을 먼저 선택해주세요.');
        if(!p.primaryArtifactId||!s.approvalToken||s.stagedInput!==JSON.stringify(p))throw Error('첫 번째 사진·명의를 먼저 확인해주세요.');
        const ctx={channel,role:'supplement',revision:supp.revision||1,primaryArtifactId:p.primaryArtifactId,primaryRevision:s.artifact.revision};
        if(!supp.extractionToken){const ex=await request('/api/image/dual/extract',envelope({...ctx,...supp.image}));supp.extractionToken=ex.extractionToken;supp.extracted=ex.extracted||ex.data;if(!supp.extractionToken||!supp.extracted)throw Error('보충사진 판독 증명이 없습니다. 다시 확인해주세요.');}
        const staged=await request('/api/image/dual/artifacts',envelope({...ctx,...supp.image,extractionToken:supp.extractionToken,extracted:supp.extracted,identityApprovalToken:s.approvalToken,purchase:purchaseValues(p),expectedArtifactId:supp.artifact?.id||null}));
        const a=staged.artifact||staged;
        if(!a.id||!a.revision||a.channel!==channel||a.role!=='supplement'||a.primaryArtifactId!==ctx.primaryArtifactId||a.primaryRevision!==ctx.primaryRevision)throw Error('보충사진과 첫 사진의 연결을 확인하지 못했습니다. 입력은 유지됩니다. 다시 확인해주세요.');
        supp.artifact=a;supp.revision=a.revision;p.supplementArtifactId=a.id;supp.stagedInput=JSON.stringify(p);s.stagedInput=JSON.stringify(p);state.bundleApprovalToken='';return a;
      }catch(e){rejectStale(e);}finally{state.busy=false;}
    }
    async function stage(channel,manual) {
      idle(); state.busy=true;
      const s=state.channels[channel], p=state.purchases[channel];
      try {
        await revalidate();
        if(!s.image) throw Error('구매 캡처를 먼저 선택해주세요.');
        const ctx={channel,role:'primary',revision:s.revision||1};
        if(!s.extractToken) {
          const ex=await request('/api/image/dual/extract',envelope({...ctx,...s.image}));
          s.extractToken=ex.extractToken; s.extractionToken=ex.extractionToken; s.extracted=ex.extracted || ex.data;
          if(!s.extractToken || !s.extractionToken || !s.extracted) throw Error('사진 판독 증명이 없습니다. 다시 분석해주세요.');
        }
        const match=await request('/api/reviewer/order-identity-match'+(manual?'/manual-confirm':''),envelope({...ctx,holdToken:state.context.campaignHoldToken,extractToken:s.extractToken,extracted:s.extracted,formFields:p,
          ...(manual?{mode:s.priorApprovalToken?'form_edit':s.reviewToken?'review':'match_error',manualConfirmed:true,reviewToken:s.reviewToken||'',priorApprovalToken:s.priorApprovalToken||''}:{})}));
        s.reviewToken=match.reviewToken; s.approvalToken=match.approvalToken;
        if(!manual && s.approvalToken && ['recipient','phone','address'].some(k=>String(p[k]||'').trim()!==String((match.resolved||s.extracted)[k]||'').trim())) {
          s.priorApprovalToken=s.approvalToken; s.approvalToken='';
          throw Error('사진 판독값과 최종 입력이 다릅니다. [내 주문 확인]을 눌러주세요.');
        }
        if(!s.approvalToken) throw Error(match.status==='REVIEW'?'입력값을 확인한 뒤 [내 주문 확인]을 눌러주세요.':'명의 승인을 받지 못했습니다. 사진과 참여 명의를 확인해주세요.');
        for(const key of Object.keys(fields)) if(String(p[key]??'').trim()==='') throw Error(fields[key]+'을 입력해주세요.');
        if(!Number.isSafeInteger(Number(p.paidAmount)) || Number(p.paidAmount)<0) throw Error('결제금액을 확인해주세요.');
        const purchase=purchaseValues(p);
        const staged=await request('/api/image/dual/artifacts',envelope({...ctx,...s.image,extractionToken:s.extractionToken,extracted:s.extracted,identityApprovalToken:s.approvalToken,purchase,expectedArtifactId:s.artifact?.id||null}));
        s.artifact=staged.artifact || staged;
        if(!s.artifact.id || !s.artifact.revision) throw Error('사진 보관을 확인하지 못했습니다. 다시 시도해주세요.');
        p.primaryArtifactId=s.artifact.id; s.revision=s.artifact.revision; s.stagedInput=JSON.stringify(p);
        return s.artifact;
      } catch(e){rejectStale(e);} finally { state.busy=false; }
    }
    function submit() {
      if(pending) return pending;
      if(state.completed) return Promise.resolve(state.result);
      pending=(async()=>{
        if(state.busy) throw Error('사진 확인이 끝난 뒤 제출해주세요.');
        state.busy=true;
        try {
        await revalidate();
        for(const ch of channels) {
          const p=state.purchases[ch],s=state.channels[ch];
          if(!p.primaryArtifactId || !s.approvalToken || s.stagedInput!==JSON.stringify(p)) throw Error('두 구매처의 캡처와 명의 확인을 모두 완료해주세요.');
          if(s.supplement?.image&&(!p.supplementArtifactId||s.supplement.stagedInput!==JSON.stringify(p)))throw Error('선택한 보충사진을 확인하거나 빼고 제출해주세요.');
        }
        for(const k of ['bank','account','depositor']) if(!String(state.bank[k]||'').trim()) throw Error('공통 은행·계좌·예금주를 입력해주세요.');
          const body=envelope({purchases:structuredClone(state.purchases),...state.bank});
          if(!state.bundleApprovalToken) { const approval=await request('/api/image/dual/approve',body); if(!approval.bundleApprovalToken) throw Error('두 주문 확인을 완료하지 못했습니다. 다시 시도해주세요.'); state.bundleApprovalToken=approval.bundleApprovalToken; }
          const {campaignId,...command}=body;
          const result=await request('/api/submit/order',{...command,bundleApprovalToken:state.bundleApprovalToken});
          state.result=result; state.completed=true; return result;
        } catch(e){rejectStale(e);} finally { state.busy=false; }
      })().finally(()=>{pending=null;});
      return pending;
    }
    if(options.serverState)applyServerState(options.serverState);
    return {state,setValues,setBank,setImage,setSupplementImage,stageSupplement,stage,submit,exportDraft,restoreDraft,updateServerState};
  }
  function apiRequest(base,headers) {
    return async (url,body) => {
      let response,data;
      try { response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...headers()},body:JSON.stringify(body)}); data=await response.json(); }
      catch(_) { throw Error('연결을 확인하지 못했습니다. 입력은 유지됩니다. 잠시 후 다시 시도해주세요.'); }
      if(!response.ok || data.ok===false || data.success===false) throw Object.assign(Error(response.status===404 || response.status===503?'동시진행 준비 중입니다. 입력은 유지됩니다. 잠시 후 새로고침해주세요.':data.error||'저장하지 못했습니다. 다시 시도해주세요.'),{status:response.status,code:data.code});
      if(data.ok!==true && data.success!==true) throw Error('서버의 저장 확인이 없습니다. 다시 시도해주세요.');
      return data;
    };
  }
  async function prepareImage(file) {
    if(!file || !file.type.startsWith('image/')) throw Error('이미지 파일을 골라주세요.');
    const bitmap=await createImageBitmap(file), scale=Math.min(1,2000/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas'); canvas.width=Math.round(bitmap.width*scale); canvas.height=Math.round(bitmap.height*scale);
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
    const data=canvas.toDataURL('image/jpeg',.88);
    if(data.length>12*1024*1024) throw Error('사진이 너무 큽니다. 크기를 줄여 다시 선택해주세요.');
    return {imageBase64:data.split(',')[1],mimeType:'image/jpeg'}; // This exact byte representation is extracted AND staged.
  }
  function mount(host,detail,context,request,onDone,options={}) {
    const controller=createController(context,request,{requireServerState:true,serverState:detail.dualPurchaseDraft,loadServerState:options.loadServerState});
    const pr=product(detail),draftKey='dualPurchaseDraft:'+context.campaignId+':'+context.campaignApplicationId;
    let restored=false;
    try { restored=controller.restoreDraft(JSON.parse(sessionStorage.getItem(draftKey)||'null')); } catch(_) { /* unavailable storage never grants approval */ }
    host.innerHTML=channels.map(ch=>'<section class="of-order-card" style="padding:16px;margin-bottom:12px"><h3>'+labels[ch]+' 구매</h3>'+Object.entries(fields).map(([k,l])=>'<div class="of-field"><label class="of-label" for="dual_'+ch+'_'+k+'">'+l+'</label><input class="of-input" id="dual_'+ch+'_'+k+'" data-channel="'+ch+'" data-field="'+k+'" '+(k==='paidAmount'?'inputmode="numeric"':'')+'></div>').join('')+
      '<label class="of-label" for="dual_'+ch+'_images">구매캡처 · 첫 사진과 보충사진(선택), 두 장까지</label><input id="dual_'+ch+'_images" type="file" accept="image/*" multiple data-image="'+ch+'" style="max-width:100%"><img alt="'+labels[ch]+' 첫 구매캡처" data-preview="'+ch+'" style="display:none;max-width:100%;max-height:100px"><img alt="'+labels[ch]+' 보충 구매캡처" data-supplement-preview="'+ch+'" style="display:none;max-width:100%;max-height:100px"><button type="button" data-remove-supplement="'+ch+'" hidden>보충사진 빼기</button><div style="display:flex;gap:8px;margin-top:10px"><button type="button" data-stage="'+ch+'">사진·명의 확인</button><button type="button" data-manual="'+ch+'" hidden>내 주문 확인</button></div><p data-status="'+ch+'" role="status">'+(restored?'입력만 복원했습니다. 사진을 다시 선택하고 확인해주세요.':'캡처와 최종 입력을 확인해주세요.')+'</p></section>').join('')+
      '<section class="of-order-card" style="padding:16px"><b data-total>합계 —원</b>'+['bank','account','depositor'].map((k,i)=>'<div class="of-field"><label class="of-label" for="dual_bank_'+k+'">'+['은행','계좌번호','예금주'][i]+'</label><input id="dual_bank_'+k+'" class="of-input" data-bank="'+k+'"></div>').join('')+'<p>두 리뷰는 각각 제출해주세요. 직원 확인·필요한 두 영수증이 완료된 뒤 지급됩니다.</p><p data-error role="alert"></p><button type="button" data-submit>두 구매처 함께 제출</button></section>';
    const error=host.querySelector('[data-error]');
    const save=()=>{try{sessionStorage.setItem(draftKey,JSON.stringify(controller.exportDraft()));}catch(_){error.textContent='이 브라우저에서는 입력 자동보관을 하지 못했습니다. 화면을 닫기 전에 제출해주세요.';}};
    host.querySelectorAll('button').forEach(el=>{el.className='btn-primary';el.style.cssText='padding:10px 12px;border-radius:10px;font-size:.8rem;justify-content:center';});
    // Shared button display CSS overrides the browser's default [hidden] rule.
    const hiddenStyle=document.createElement('style');hiddenStyle.textContent='[data-manual][hidden],[data-remove-supplement][hidden]{display:none!important}';host.appendChild(hiddenStyle);
    const lock=busy=>host.querySelectorAll('input,button').forEach(el=>{el.disabled=busy;});
    const values=ch=>Object.fromEntries([...host.querySelectorAll('[data-channel="'+ch+'"]')].map(el=>[el.dataset.field,el.dataset.field==='paidAmount'?(el.value.trim()===''?'':Number(el.value)):el.value.trim()]));
    const update=()=>{const total=channels.reduce((sum,ch)=>sum+Number(values(ch).paidAmount||0),0);host.querySelector('[data-total]').textContent='합계 '+total.toLocaleString('ko-KR')+'원';};
    const showInvalidated=skip=>channels.filter(ch=>ch!==skip).forEach(ch=>{
      if(!controller.state.purchases[ch].primaryArtifactId&&controller.state.channels[ch].image){host.querySelector('[data-status="'+ch+'"]').textContent='조건·명의 또는 사진이 바뀌었습니다. 다시 확인해주세요.';host.querySelector('[data-manual="'+ch+'"]').hidden=true;}
    });
    host.querySelectorAll('[data-channel]').forEach(el=>{
      el.value=controller.state.purchases[el.dataset.channel][el.dataset.field]??(el.dataset.field==='paidAmount'?pr?.channels?.[el.dataset.channel]?.pay??'':'');
      el.addEventListener('input',()=>{try{controller.setValues(el.dataset.channel,values(el.dataset.channel));host.querySelector('[data-status="'+el.dataset.channel+'"]').textContent='입력이 바뀌었습니다. 첫 사진과 보충사진을 다시 확인해주세요.';host.querySelector('[data-manual="'+el.dataset.channel+'"]').hidden=true;update();save();}catch(e){error.textContent=e.message;}});
    });
    channels.forEach(ch=>controller.setValues(ch,values(ch)));
    host.querySelectorAll('[data-bank]').forEach(el=>{el.value=controller.state.bank[el.dataset.bank]||'';el.addEventListener('input',()=>{try{controller.setBank(Object.fromEntries([...host.querySelectorAll('[data-bank]')].map(e=>[e.dataset.bank,e.value.trim()])));save();}catch(e){error.textContent=e.message;}});});
    const preview=(selector,image)=>{const el=host.querySelector(selector);if(image){el.src='data:'+image.mimeType+';base64,'+image.imageBase64;el.style.display='';}else{el.removeAttribute('src');el.style.display='none';}};
    host.querySelectorAll('[data-image]').forEach(el=>el.addEventListener('change',async()=>{
      if(controller.uiBusy)return;controller.uiBusy=true;lock(true);const ch=el.dataset.image;
      try{
        await controller.setImage(ch,null);preview('[data-preview="'+ch+'"]',null);preview('[data-supplement-preview="'+ch+'"]',null);host.querySelector('[data-remove-supplement="'+ch+'"]').hidden=true;host.querySelector('[data-manual="'+ch+'"]').hidden=true;
        const files=[...el.files].slice(0,2);
        if(files.length){const image=await prepareImage(files[0]);await controller.setImage(ch,image);preview('[data-preview="'+ch+'"]',image);if(files[1]){const supplement=await prepareImage(files[1]);await controller.setSupplementImage(ch,supplement);preview('[data-supplement-preview="'+ch+'"]',supplement);host.querySelector('[data-remove-supplement="'+ch+'"]').hidden=false;}}
        host.querySelector('[data-status="'+ch+'"]').textContent=files.length?'사진이 바뀌었습니다. 다시 확인해주세요.':'사진을 선택해주세요.';error.textContent='';save();
      }catch(e){error.textContent=e.message;}finally{lock(false);controller.uiBusy=false;}
    }));
    host.querySelectorAll('[data-remove-supplement]').forEach(el=>el.onclick=async()=>{try{const ch=el.dataset.removeSupplement;await controller.setSupplementImage(ch,null);preview('[data-supplement-preview="'+ch+'"]',null);el.hidden=true;host.querySelector('[data-status="'+ch+'"]').textContent='보충사진을 뺐습니다. 첫 사진 확인은 유지됩니다.';save();}catch(e){error.textContent=e.message;}});
    async function stage(ch,manual){
      if(controller.uiBusy)return;controller.uiBusy=true;error.textContent='';const st=host.querySelector('[data-status="'+ch+'"]');lock(true);
      try{
        controller.setValues(ch,values(ch));st.textContent='사진·명의 확인 중…';
        // A failed supplement retries on the same primary, never re-approves identity from the supplement.
        const s=controller.state.channels[ch];
        if(manual||!controller.state.purchases[ch].primaryArtifactId||!s.approvalToken)await controller.stage(ch,manual);
        else if(options.loadServerState)controller.updateServerState(await options.loadServerState());
        if(!controller.state.purchases[ch].primaryArtifactId||!s.approvalToken)await controller.stage(ch,manual);
        if(s.supplement?.image){st.textContent='첫 사진 확인 완료 · 보충사진 보관 중…';await controller.stageSupplement(ch);st.textContent='✓ 첫 사진·명의·보충사진 보관 완료';}
        else st.textContent='✓ 사진 보관·명의 승인 완료';
        host.querySelector('[data-manual="'+ch+'"]').hidden=true;
      }catch(e){st.textContent=e.message;const s=controller.state.channels[ch];host.querySelector('[data-manual="'+ch+'"]').hidden=!(s.reviewToken||s.priorApprovalToken);}
      finally{showInvalidated(ch);lock(false);controller.uiBusy=false;save();}
    }
    host.querySelectorAll('[data-stage]').forEach(el=>el.onclick=()=>stage(el.dataset.stage,false));
    host.querySelectorAll('[data-manual]').forEach(el=>el.onclick=()=>stage(el.dataset.manual,true));
    controller.submitFromUi=async()=>{
      if(controller.uiSubmitting||controller.uiBusy)return;controller.uiSubmitting=true;lock(true);error.textContent='';
      try{await controller.submit();try{sessionStorage.removeItem(draftKey);}catch(_){}host.innerHTML='<div class="of-order-card" style="padding:20px"><h3>구매양식 접수 완료</h3><p>네이버·쿠팡 구매가 한 건으로 접수됐습니다.</p></div>';if(onDone)onDone(controller.state.result);}
      catch(e){error.textContent=e.message;showInvalidated();save();}finally{lock(false);controller.uiSubmitting=false;}
    };
    host.querySelector('[data-submit]').onclick=controller.submitFromUi;update();return controller;
  }
  const exports={product,createController,apiRequest,prepareImage,mount};
  if(typeof module!=='undefined') module.exports=exports;
  root.DualChannelPurchase=exports;
})(typeof window==='undefined'?globalThis:window);
