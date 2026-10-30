'use strict';
// Execute the production renderer and action handler: no copy of stock rules.
const assert=require('assert/strict');
const fs=require('fs');
const vm=require('vm');
const wd=fs.readFileSync(require('path').join(__dirname,'../../frontend/workdesk.html'),'utf8');
function setup(){
 const c={STATE:{role:'master',canEdit:true,cur:{sheetId:'s',tabName:'a',tabGid:'1'}},esc:s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'),confirm:()=>true,alert:()=>{},calls:[],reloads:0};
 c.api=async(url,opts)=>{c.calls.push({url,body:JSON.parse(opts.body)});return {ok:true};};
 c.reloadWorkdesk=async()=>c.reloads++;
 vm.createContext(c);
 vm.runInContext(wd.slice(wd.indexOf('function _cndSalesRow('),wd.indexOf('/* ★ 결정 266: 가격 신고')),c);
 vm.runInContext(wd.slice(wd.indexOf('async function _cndSale(i)'),wd.indexOf('/* [미설정] 창구')),c);
 return c;
}
const cd={campaignId:42,optionSales:Array.from({length:24},(_,i)=>({optKey:'상품 '+i,paused:i===17,reports:i===12?1:0}))};
(async()=>{
 const c=setup(); c.STATE.wd={condition:cd};
 const before=JSON.stringify(cd.optionSales),html=c._cndSalesRow(cd);
 assert.match(html,/외 23개 펼치기/,'approved one-line disclosure exists');
 assert.match(html,/aria-expanded="false"/,'default collapsed');
 assert.match(html,/class="cndsalesmore"[^>]*hidden/,'remaining options start hidden');
 const indices=[...html.matchAll(/onclick="_cndSale\((\d+)\)"/g)].map(m=>Number(m[1]));
 assert.deepEqual(indices,[12,17,...Array.from({length:24},(_,i)=>i).filter(i=>i!==12&&i!==17)],'urgent first, stable original order within groups');
 assert.equal(JSON.stringify(cd.optionSales),before,'never mutate the server array');
 assert.equal(new Set(indices).size,24,'first option is not duplicated');
 for(const i of indices){await c._cndSale(i);assert.deepEqual(c.calls.at(-1).body,{optKey:cd.optionSales[i].optKey,paused:!cd.optionSales[i].paused});}
 assert.equal(c.reloads,24);
 // Disclosure only mutates its local DOM; the task/campaign key protects stale buttons.
 const more={hidden:true,children:Array(23)},attrs={};
 const dd={dataset:{salesKey:c.STATE._cndSalesView.key},querySelector:()=>more};
 const button={closest:()=>dd,setAttribute:(k,v)=>attrs[k]=v,textContent:''};
 c._cndSalesToggle(button);assert.equal(more.hidden,false);assert.equal(attrs['aria-expanded'],'true');assert.equal(button.textContent,'접기');
 assert.match(c._cndSalesRow(JSON.parse(JSON.stringify(cd))),/aria-expanded="true"/,'same-task realtime redraw stays expanded');
 c._cndSalesToggle(button);assert.equal(more.hidden,true);assert.equal(button.textContent,'외 23개 펼치기');
 c._cndSalesToggle(button);c.STATE.cur.tabGid='2';assert.match(c._cndSalesRow(cd),/aria-expanded="false"/,'other tab starts collapsed');
 c._cndSalesToggle(button);assert.equal(c.STATE._cndSalesView.expanded,false,'old tab button cannot expand new tab');
 for(const field of ['sheetId','tabGid']){c.STATE._cndSalesView.expanded=true;c.STATE.cur[field]+='-other';assert.match(c._cndSalesRow(cd),/aria-expanded="false"/);}
 c.STATE._cndSalesView.expanded=true;assert.match(c._cndSalesRow({...cd,campaignId:43}),/aria-expanded="false"/,'other campaign starts collapsed');
 assert.equal(c._cndSalesRow(null),'');assert.equal(c._cndSalesRow({campaignId:42,optionSales:[]}), '');assert.equal(c._cndSalesRow({optionSales:cd.optionSales}), '');
 assert.doesNotMatch(c._cndSalesRow({campaignId:42,optionSales:[cd.optionSales[0]]}),/cndsalestoggle|cndsalesmore/,'one row has no meaningless disclosure');
 c.STATE.role='advertiser';assert.equal(c._cndSalesRow(cd),'');
 c.STATE.role='staff';c.STATE.canEdit=false;
 const readonly=c._cndSalesRow(cd);assert.doesNotMatch(readonly,/cndsalebtn|cndsalestoggle/);assert.match(readonly,/신고 1/);assert.equal((readonly.match(/class="cndsalerow"/g)||[]).length,1,'readonly keeps only report rows, unchanged');
 assert.equal(c._cndSalesRow({campaignId:42,optionSales:[cd.optionSales[0]]}), '');
 c.STATE.canEdit=true;c.STATE.wd.condition={campaignId:42,optionSales:[{optKey:'',whole:true,paused:false}]};
 assert.doesNotMatch(c._cndSalesRow(c.STATE.wd.condition),/cndsalenm|cndsalestoggle/,'whole campaign keeps unnamed single action');
 await c._cndSale(0);assert.deepEqual(c.calls.at(-1).body,{whole:true,paused:true});
 const n=c.calls.length;c.confirm=()=>false;await c._cndSale(0);assert.equal(c.calls.length,n,'cancel confirmation never submits');
 c.confirm=()=>true;c.api=async()=>({ok:false,error:'권한 없음'});let alert='';c.alert=m=>alert=m;const reloads=c.reloads;await c._cndSale(0);assert.equal(alert,'권한 없음');assert.equal(c.reloads,reloads,'denied request does not redraw as success');
 console.log('PASS collapsed/expanded/redraw/task isolation, 0/1/24, urgent order/original-index actions, readonly/advertiser, whole campaign, cancel/denied');
})().catch(e=>{console.error(e);process.exitCode=1;});
