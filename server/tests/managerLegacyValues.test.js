'use strict';
const assert=require('assert');
const {buildPushBody}=require('../src/services/sharedSyncPush.service');
const {canon,ownerOf}=require('../src/utils/sharedFields');
const {WRITABLE_BY_ORIGIN,PUSH_VIEW_KEYS}=require('../src/services/sharedPatch.service');
assert.equal(ownerOf('work_manager'),'shared');
assert.equal(ownerOf('manager_name'),'intranet');
assert.ok(WRITABLE_BY_ORIGIN.intranet.has('work_manager'));
assert.ok(WRITABLE_BY_ORIGIN.rw_admin.has('work_manager'));
assert.ok(!WRITABLE_BY_ORIGIN.campaign.has('work_manager'));
assert.ok(PUSH_VIEW_KEYS.includes('work_manager'));
assert.equal(canon('work_manager','만두'),canon('work_manager','박세희'));
assert.equal(canon('work_manager','망고'),canon('work_manager','박은비'));
for(const [input,expected] of [['','랜덤'],[null,'랜덤'],['랜덤배정','랜덤'],['만두','박세희'],['망고','박은비'],['박세희 (만두)','박세희']]){
 const wo={id:'wo_FAKE_legacy',source_review_order_id:'IA-FAKE',sync_version:12,work_manager:input,special_notes:'별도 메모'};
 const copy=JSON.stringify(wo),narrow=buildPushBody(wo,'manager'),full=buildPushBody(wo);
 assert.deepEqual(narrow.view,{work_manager:expected});
 assert.equal(full.view.work_manager,expected);
 assert.equal(JSON.stringify(wo),copy,'송신 정규화는 과거 원본을 고치지 않는다');
}
(async()=>{
 const db={query:async()=>({rows:[]})};
 require('../src/db/pool').query=db.query;
 const svc=require('../src/services/trackB.service');
 const {resolveWorkManager}=require('../src/utils/workManager');
 for(const [orderWorkManager,tabManager] of [['박세희','망고'],['박은비','만두'],['랜덤','망고'],['','']]){
  const summary=await svc.tabConditionSummary(db,{sheetId:'FAKE',tabName:'가짜',meta:{manager:tabManager},wo:{id:'wo_FAKE',createdBy:'가짜AE',managerName:'담당AE를작업담당으로쓰면실패',workManager:orderWorkManager}});
  assert.ok(summary,'실제 조건 요약 함수를 실행한다');
  const expected=resolveWorkManager({orderWorkManager,tabManager}).manager||null;
  assert.equal(summary.manager.adminNick,expected,'조건·홈·입금관리 담당자 판정이 같다');
  assert.equal(summary.manager.ae,'가짜AE');
 }
 console.log('managerLegacyValues: owner/writable/alias/unassigned push + actual condition manager alignment passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
