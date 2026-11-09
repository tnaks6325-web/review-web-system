/* Purchase capture self-service: no shared-page state or legacy upload writes. */
(function (global) {
  'use strict';
  let reviewer = null, staff = null, generation = 0;
  const saveLabels = {saved:'사진 접수',failed:'저장 실패',unknown:'연결 확인 중',missing:'사진 미접수',uploading:'사진 저장 중'};
  const reviewLabels = {not_requested:'확인 요청 전',pending:'담당자 확인 중',needs_photo:'사진 보완 필요',confirmed:'사진 확인 완료'};
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function button(text, action, fn) {
    const b = el('button',text); b.type='button'; b.dataset.action=action;
    b.addEventListener('click',fn); return b;
  }
  function identityOf(user) {
    // A renewed credential is not a different reviewer account.
    return JSON.stringify(user,function(key,value){return key==='reviewerToken'?undefined:value;});
  }
  function alive(c) {
    return !c.dead && (c.staff ? staff : reviewer) === c && c.root.isConnected &&
      c.identity === identityOf(c.user);
  }
  function errorText(error) {
    return ({401:'로그인이 만료됐어요. 다시 로그인해 주세요.',403:'이 사진을 처리할 권한이 없어요.',404:'이 주문이나 요청을 찾을 수 없어요.',409:'사진이나 처리 상태가 바뀌었어요. 새로 확인해 주세요.',413:'사진이 너무 커요. 작은 사진으로 다시 선택해 주세요.',503:'지금은 처리할 수 없어요. 잠시 뒤 다시 시도해 주세요.'})[error.status] || '연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  }
  function stale() { const e=new Error('stale'); e.stale=true; return e; }
  async function api(c,path,body) {
    const seq=c.generation;
    for (let attempt=0;attempt<2;attempt++) {
      const token=await (attempt ? c.getToken({forceRefresh:true}) : c.getToken());
      if(!alive(c)||seq!==c.generation) throw stale();
      if(!token) throw Object.assign(new Error('auth'),{status:401});
      const headers=c.staff ? {Authorization:'Bearer '+token} : {'X-Reviewer-Token':token};
      if(body) headers['Content-Type']='application/json';
      const response=await global.fetch(c.base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,credentials:'omit',cache:'no-store'});
      if(!alive(c)||seq!==c.generation) throw stale();
      if(response.status===401 && attempt===0) continue;
      let data; try {data=await response.json();} catch (_) {throw new Error('invalid response');}
      if(!alive(c)||seq!==c.generation) throw stale();
      if(!response.ok||!data||data.ok!==true) throw Object.assign(new Error('api'),{status:response.status,code:data&&data.code});
      return data;
    }
  }
  function itemValid(c,item) {
    return item && item.orderSubmissionId!=null && Array.isArray(item.channels) &&
      item.channels.every(ch=>ch && ['single','naver','coupang'].includes(ch.channel) && Array.isArray(ch.photos) && ch.photos.every(p=>p && typeof p==='object')) &&
      (c.order==null || String(item.orderSubmissionId)===c.order);
  }
  function endpoint(c) {return c.staff?'/api/trackb/purchase-capture-checks/'+encodeURIComponent(c.requestId):'/api/reviewer/purchase-captures'+(c.order==null?'':'/'+encodeURIComponent(c.order));}
  function staffTarget(item,requestId) {
    const matches=item.channels.filter(ch=>ch.request && String(ch.request.id)===String(requestId));
    return matches.length===1?matches[0]:null;
  }
  function dispose(c) {
    if(!c) return;
    c.dead=true; c.pending=null;
    if(c.photoDialog) c.photoDialog.remove();
    if(c.unload) global.removeEventListener('beforeunload',c.unload);
    if(c.dialog) c.dialog.remove(); else c.root.replaceChildren();
  }
  function context(opts,isStaff,container) {
    const base=String(opts.apiBase||'').replace(/\/$/,'').replace(/\/api$/,'');
    const c={staff:isStaff,user:opts.user,identity:identityOf(opts.user),getToken:opts.getToken,base,generation:++generation,root:container,order:opts.orderSubmissionId==null?null:String(opts.orderSubmissionId),requestId:opts.requestId==null?null:String(opts.requestId),onChanged:opts.onChanged,onOpenThread:opts.onOpenThread,busy:false,pending:null};
    c.folds=new Map();
    c.unload=e=>{if(c.busy){e.preventDefault();e.returnValue='';}};
    global.addEventListener('beforeunload',c.unload);
    return c;
  }
  function shell(c) {
    c.root.classList.add('rpc');
    c.content=el('div',null,'rpc-content');c.message=el('p',null,'rpc-message');c.message.setAttribute('role','status');
    c.root.replaceChildren(c.message,c.content);
  }
  function modal(opts,isStaff) {
    const dialog=el('dialog',null,'rpc rpc-dialog');
    const head=el('header');head.append(el('h2',isStaff?'구매사진 확인':'구매 캡처 확인'));
    const root=el('div');dialog.append(head,root);document.body.append(dialog);
    const c=context(opts,isStaff,root);c.dialog=dialog;
    head.append(button('닫기','close',()=>{if(c.busy){c.message.textContent='사진 처리가 끝날 때까지 기다려 주세요.';return;}dispose(c);}));
    dialog.addEventListener('cancel',e=>{e.preventDefault();if(!c.busy) dispose(c);});
    dialog.showModal();shell(c);return c;
  }
  function photo(c,p,index) {
    const wrap=el('div',null,'rpc-thumb');
    const label=(p.isSupplement?'추가':'원본')+' '+(index+1);
    wrap.append(el('span',label));
    if(!p.fileId) {wrap.append(el('span','사진 연결 확인 불가'));return wrap;}
    // Public contract supplies fileId only; never trust an arbitrary response URL.
    const url=c.base+'/api/drive/image/'+encodeURIComponent(String(p.fileId));
    const b=button('','photo',()=>{
      if(!alive(c)) return;
      if(c.photoDialog) c.photoDialog.remove();
      const view=el('dialog',null,'rpc rpc-photo-dialog');
      c.photoDialog=view;
      const img=el('img');img.alt=label;img.src=url;
      view.append(button('닫기','close-photo',()=>view.remove()),img);
      view.addEventListener('cancel',e=>{e.preventDefault();view.remove();});
      document.body.append(view);view.showModal();
      img.addEventListener('error',()=>{img.replaceWith(el('p','사진 연결 확인 불가 · 저장 기록과는 별개예요.'));});
    });
    b.setAttribute('aria-label',label+' 전체 보기');
    const img=el('img');img.alt=label;img.loading='lazy';img.src=url;
    img.addEventListener('error',()=>{img.hidden=true;b.append(el('span','사진 연결 확인 불가'));},{once:true});
    b.append(img);wrap.append(b);
    if(p.createdAt) wrap.append(el('small',p.createdAt));
    return wrap;
  }
  function lock(c,value) {
    c.busy=value;
    c.root.querySelectorAll('button,input,textarea').forEach(n=>{if(value){n.dataset.wasDisabled=n.disabled?'1':'0';n.disabled=true;}else if(n.dataset.wasDisabled!=null){n.disabled=n.dataset.wasDisabled==='1';delete n.dataset.wasDisabled;}});
    if(c.dialog) c.dialog.querySelector('header button').disabled=value;
  }
  function capability(c,ch,b,key) {
    b.disabled=!ch.capabilities || ch.capabilities[key]!==true || !ch.evidenceHash;
    if(b.disabled){const why=(ch.capabilities&&ch.capabilities.reason)||'현재 이 작업을 사용할 수 없어요. 상태를 새로 확인해 주세요.';b.title=why;c.append(el('p',why,'rpc-muted'));}
  }
  async function readFile(file) {
    if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)) throw Object.assign(new Error('file'),{friendly:'PNG·JPG·WEBP 사진을 선택해 주세요.'});
    if(global.ImageShrink&&global.ImageShrink.fromFile) {
      const data=await global.ImageShrink.fromFile(file,1920,0.8,{longest:true});
      if(data&&data.base64&&data.base64.length<=6000000) return data;
      throw Object.assign(new Error('file'),{friendly:'사진을 읽지 못했거나 너무 커요. 다른 사진을 선택해 주세요.'});
    }
    if(file.size>4500000) throw Object.assign(new Error('file'),{friendly:'사진이 너무 커요. 작은 사진으로 다시 선택해 주세요.'});
    return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({base64:String(r.result).split(',')[1],mime:file.type});r.onerror=()=>reject(new Error('read'));r.readAsDataURL(file);});
  }
  async function write(c,path,body,success,orderId) {
    if(c.busy||!alive(c)) return;
    lock(c,true);c.message.textContent='처리 중이에요…';
    try {
      const data=await api(c,path,body);
      if(!itemValid(c,data.item) || (orderId!=null && String(data.item.orderSubmissionId)!==String(orderId))) throw new Error('wrong order');
      const channel=c.staff?c.staffChannel:body.channel;
      if(!data.item.channels.some(ch=>ch.channel===channel)) throw new Error('wrong channel');
      if(c.staff && (!data.request || String(data.request.id)!==c.requestId)) throw new Error('wrong request');
      if(c.staff && (!staffTarget(data.item,c.requestId) || staffTarget(data.item,c.requestId).channel!==c.staffChannel)) throw new Error('wrong request channel');
      if(c.pending && body.requestKey===c.pending.body.requestKey) c.pending=null;
      await load(c);
      if(alive(c)&&!c.loadFailed){c.message.textContent=success;if(c.onChanged){try{c.onChanged(data);}catch(_){/* Parent refresh failure must not relabel a committed decision. */}}}
    } catch(e) {
      if(!alive(c)||e.stale) return;
      // A lost response is not a failed save. Re-read, but never infer receipt from photo count.
      await load(c);
      if(alive(c)) c.message.textContent=errorText(e)+(c.loadFailed?' 내역을 불러오지 못했어요. 접수 여부를 확인하지 못했어요.':' 접수 여부는 다시 조회했어요. 성공으로 확정하지 않았어요.');
    } finally {if(alive(c)){lock(c,false);render(c);}}
  }
  function renderItem(c,item) {
    const box=el('section',null,'rpc-item');
    box.append(el('h3',item.displayName||'구매사진'),el('p',item.participantName||'','rpc-muted'));
    for(const ch of item.channels) {
      const section=el('details');section.dataset.channel=ch.channel;
      const foldKey=JSON.stringify([String(item.orderSubmissionId),ch.channel]);
      section.dataset.foldKey=foldKey;
      section.open=c.folds.has(foldKey)?c.folds.get(foldKey):ch.reviewState==='needs_photo'||ch.saveState==='failed'||ch.saveState==='missing'||ch.saveState==='unknown'||ch.saveState==='uploading';
      section.addEventListener('toggle',()=>{if(section.isConnected)c.folds.set(foldKey,section.open);});
      const summary=el('summary');summary.append(el('strong',ch.channel==='single'?(ch.label||'구매사진'):(ch.label||ch.channel)+' 구매사진'),el('span',(saveLabels[ch.saveState]||'저장 상태 확인 불가')+' · '+(reviewLabels[ch.reviewState]||'확인 상태 없음')));section.append(summary);
      const body=el('div',null,'rpc-section');
      if(ch.reason)body.append(el('p',ch.reason,'rpc-reason'));
      const photos=el('div',null,'rpc-photos');(Array.isArray(ch.photos)?ch.photos:[]).forEach((p,i)=>photos.append(photo(c,p,i)));body.append(photos);
      if(ch.request){body.append(el('p','확인 요청 · '+(reviewLabels[ch.request.status]||ch.request.status||'상태 확인 불가'),'rpc-muted'));if(ch.request.note)body.append(el('p',ch.request.note));}
      if(!c.staff) reviewerActions(c,item,ch,body);
      section.append(body);box.append(section);
    }
    box.append(el('p','사진 확인과 명의·리뷰·입금 승인은 별개예요.','rpc-muted'));
    return box;
  }
  function reviewerActions(c,item,ch,body) {
    const path='/api/reviewer/purchase-captures/'+encodeURIComponent(item.orderSubmissionId);
    const actions=el('div',null,'rpc-actions');
    const input=el('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.hidden=true;
    const add=button('사진 추가','add',()=>input.click());capability(body,ch,add,'canAdd');
    input.addEventListener('change',async()=>{
      if(c.busy||!alive(c)||!input.files[0])return;
      lock(c,true);c.message.textContent='사진을 준비하고 있어요…';
      try {
        const data=await readFile(input.files[0]);if(!alive(c))return;
        c.pending={order:String(item.orderSubmissionId),channel:ch.channel,path:path+'/supplements',body:{channel:ch.channel,imageBase64:data.base64,mimeType:data.mime,requestKey:global.crypto.randomUUID(),expectedEvidenceHash:ch.evidenceHash}};
        c.message.textContent='선택한 사진을 저장해 주세요. 기존 사진은 그대로 남아요.';
      }catch(e){if(alive(c))c.message.textContent=e.friendly||'사진을 읽지 못했어요.';}
      finally{if(alive(c)){lock(c,false);render(c);}}
    });
    const note=el('textarea');note.placeholder='확인할 내용 (선택)';note.setAttribute('aria-label',(ch.label||ch.channel)+' 확인할 내용');note.maxLength=1000;
    const request=button('이미 제출했어요 · 확인 요청','request',()=>write(c,path+'/check-requests',{channel:ch.channel,expectedEvidenceHash:ch.evidenceHash,note:note.value.trim()},'확인 요청을 접수했어요. 담당자 확인을 기다려 주세요.',item.orderSubmissionId));
    capability(body,ch,request,'canRequestCheck');
    actions.append(add,input,request);body.append(actions,note);
    if(c.pending && c.pending.order===String(item.orderSubmissionId)&&c.pending.channel===ch.channel) {
      const pending=c.pending;
      body.append(el('p','선택한 추가 사진 · 아직 접수 여부를 확정하지 않았어요.','rpc-muted'),button('사진 저장 · 다시 시도','save',()=>write(c,pending.path,pending.body,'사진을 접수했어요. 담당자 확인을 기다려 주세요.',pending.order)));
    }
    if(ch.request&&c.onOpenThread)body.append(button('문의 보기','thread',()=>c.onOpenThread(ch.request)));
  }
  function render(c) {
    if(!alive(c))return;
    // Read the DOM synchronously: native details.toggle may still be queued when
    // an already-small image helper resolves immediately after a user click.
    c.content.querySelectorAll('details[data-fold-key]').forEach(n=>c.folds.set(n.dataset.foldKey,n.open));
    c.content.replaceChildren();
    if(c.items){for(const item of c.items)c.content.append(renderItem(c,item));if(!c.items.length)c.content.append(el('p','지금 표시할 구매사진 내역이 없어요.'));if(c.hasMore)c.content.append(el('p','표시되지 않은 내역이 더 있을 수 있어요.','rpc-muted'));}
    if(c.loadFailed)c.content.append(button('다시 조회','reload',()=>load(c)));
    if(c.staff&&c.item&&c.request) staffActions(c);
    if(c.busy) { c.root.querySelectorAll('button,input,textarea').forEach(n=>{n.disabled=true;}); }
    if(c.loadFailed) c.root.querySelectorAll('[data-action="add"],[data-action="request"],[data-action="save"]').forEach(n=>{n.disabled=true;});
  }
  async function load(c) {
    if(!alive(c))return;
    const ticket=(c.readTicket||0)+1;c.readTicket=ticket;c.message.textContent='사진 내역을 확인하고 있어요…';
    try {
      const data=await api(c,endpoint(c));if(c.readTicket!==ticket||!alive(c))return;
      const items=c.staff||c.order!=null?[data.item]:data.items;
      if(!Array.isArray(items)||!items.every(i=>itemValid(c,i)))throw new Error('invalid item');
      if(c.staff){const target=staffTarget(data.item,c.requestId);if(!data.request||String(data.request.id)!==c.requestId||!target||(c.staffChannel&&c.staffChannel!==target.channel))throw new Error('invalid request');c.staffChannel=target.channel;c.order=String(data.item.orderSubmissionId);c.request=data.request;c.item=data.item;}
      c.items=items;c.hasMore=data.hasMore===true;c.loadFailed=false;c.message.textContent='';render(c);
    }catch(e){if(!alive(c)||e.stale||c.readTicket!==ticket)return;c.loadFailed=true;c.message.textContent=errorText(e)+' 내역을 불러오지 못했어요.';render(c);}
  }
  function staffActions(c) {
    const target=staffTarget(c.item,c.requestId);
    const section=el('section',null,'rpc-staff');
    const note=el('textarea');note.setAttribute('aria-label','보완 사유');note.placeholder='보완이 필요하면 이유를 적어 주세요';note.maxLength=1000;
    const checked=el('input');checked.type='checkbox';const label=el('label','현재 요청 구매처의 사진을 직접 확인했어요');label.prepend(checked);
    function decide(decision){
      if(c.busy||!checked.checked)return;
      if(decision==='needs_photo'&&!note.value.trim()){c.message.textContent='보완 사유를 적어 주세요.';note.focus();return;}
      write(c,endpoint(c)+'/decision',{decision,note:note.value.trim(),expectedEvidenceHash:target.evidenceHash},decision==='confirmed'?'사진 확인 완료를 기록했어요.':'보완 사유를 전달했어요.');
    }
    section.append(el('h3',(target.label||target.channel)+' 사진 처리'),el('p','명의·입금 승인은 별도로 처리해 주세요.','rpc-muted'),label,note);
    const need=button('사진 보완 요청','needs_photo',()=>decide('needs_photo'));
    const confirm=button('사진 확인 완료','confirmed',()=>decide('confirmed'));
    need.disabled=confirm.disabled=true;
    checked.addEventListener('change',()=>{need.disabled=confirm.disabled=!checked.checked||!target.evidenceHash||c.loadFailed;});
    section.append(need,confirm);c.content.append(section);
  }
  global.ReviewerPurchaseCapture={
    mount:function(opts){dispose(reviewer);reviewer=context(opts,false,typeof opts.container==='string'?document.querySelector(opts.container):opts.container);shell(reviewer);return load(reviewer);},
    open:function(opts){dispose(reviewer);reviewer=modal(opts,false);return load(reviewer);},
    reset:function(){dispose(reviewer);reviewer=null;}
  };
  global.PurchaseCaptureStaff={open:function(opts){dispose(staff);staff=modal(opts,true);return load(staff);}};
})(window);
