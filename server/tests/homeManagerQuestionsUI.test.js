'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'../../frontend/workdesk.html'),'utf8');
const src=html.slice(html.indexOf('const TCK_CHOICES='),html.indexOf('/** nav 뱃지',html.indexOf('const TCK_CHOICES=')));
const ctx={STATE:{},window:{addEventListener(){}},document:{getElementById:()=>null},esc:s=>String(s||'').replaceAll('<','&lt;'),toast(){},matchMedia:()=>({matches:false,addEventListener(){}})};
vm.createContext(ctx);vm.runInContext(src,ctx);
(async()=>{
 const q={id:501,kind:'manager_assignment',canAnswer:true,status:'open',facts:{workOrderId:'fake',title:'가짜 <상품>',baseVersion:0},lines:[{key:'manager',text:'작업담당이 미지정입니다. 만두·망고 중 누가 맡을까요?'}],answers:{}};
 ctx.STATE.tckItems=[];ctx.STATE.tckManagerItems=[q];
 let home=ctx._tckHtml('home');assert.match(home,/만두/);assert.match(home,/망고/);assert.match(home,/가짜 &lt;상품>/);assert.doesNotMatch(home,/케이뱅크|_tckGo\(/);
 assert.doesNotMatch(ctx._tckHtml('payment'),/가짜|담당자 배정/);
 ctx.STATE.tckMgr='망고';assert.match(ctx._tckHtml('home'),/가짜/, 'unassigned remains visible under manager chip');ctx.STATE.tckMgr='';
 q.canAnswer=false;assert.doesNotMatch(ctx._tckHtml('home'),/onclick="_tckManagerAnswer/);q.canAnswer=true;
 ctx.STATE.tckItems=null;ctx.STATE.tckError='가짜 <은행 오류>';
 for(const compact of [false,true]){ctx.matchMedia=()=>({matches:compact,addEventListener(){}});home=ctx._tckHtml('home');assert.match(home,/통장 확인 항목을 불러오지 못했습니다/,'partial bank failure stays visible with manager questions');assert.match(home,/가짜 &lt;은행 오류>/);assert.match(home,/가짜 &lt;상품>/);assert.doesNotMatch(home,/지금 확인할 것이 없습니다/);}
 assert.match(ctx._tckHtml('payment'),/확인할 것을 불러오지 못했습니다/,'payment failure unchanged');
 ctx.STATE.tckItems=[];ctx.STATE.tckError='';ctx.matchMedia=()=>({matches:false,addEventListener(){}});
 ctx._tckHtml('home');let calls=0,resolve;
 ctx.api=async(url,opts)=>{calls++;assert.match(url,/501\/manager-answer$/);assert.deepEqual(JSON.parse(opts.body),{choice:'mandu',baseVersion:0});return new Promise(r=>resolve=r);};
 const pending=ctx._tckManagerAnswer(0,0);await ctx._tckManagerAnswer(0,1);assert.equal(calls,1,'double click blocked');assert.equal(q.status,'open','no optimistic assignment');
 resolve({ok:false,error:'가짜 실패'});await pending;assert.equal(ctx.STATE.tckManagerItems[0].status,'open');
 ctx._tckHtml('home');ctx.api=async()=>({ok:true,item:{...q,status:'done',localSaved:true,remoteSync:'pending',answers:{manager:{choice:'mandu'}}}});
 await ctx._tckManagerAnswer(0,0);home=ctx._tckHtml('home');assert.match(home,/리뷰웹 저장 완료/);assert.match(home,/인트라넷 전달 대기/);
 console.log('manager home runtime: permission, escaping, home-only, chip, duplicate, failure, stored vs pending PASS');
})().catch(e=>{console.error(e);process.exit(1)});
