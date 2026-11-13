'use strict';
// 결정 370 — 구매사진 창의 작은 상품 사진(thumbnailUrl).
// 공고 썸네일(참여 연결) → 없으면 그 작업에 연결된 공고 → https 만 · 조회가 실패해도 목록은 깨지지 않는다(SAVEPOINT).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,OWNER,SINGLE,BUNDLE}=require('./helpers/purchaseCaptureIntegrationFixture');

const session={ownerReviewerId:OWNER,loginKind:'self',loginPhone8:'12345678',loginName:'시험 리뷰어'};
const thumbs=async h=>Object.fromEntries((await h.core.listForReviewer({session})).items.map(i=>[i.orderSubmissionId,i.thumbnailUrl]));

test('공고 썸네일을 싣고 · 참여 연결이 없는 작업 주문은 연결된 공고에서 찾고 · https 가 아니면 싣지 않는다 · 조회 실패는 빈 자리',async()=>{
 const h=await fixture();
 try{
  assert.deepEqual(await thumbs(h),{[SINGLE]:null,[BUNDLE]:null},'썸네일 없는 공고 = null');

  await h.pg.query("UPDATE recruit_campaigns SET thumbnail_url='https://shop-phinf.pstatic.net/a.jpg' WHERE id='local-campaign'");
  assert.deepEqual(await thumbs(h),{[SINGLE]:null,[BUNDLE]:'https://shop-phinf.pstatic.net/a.jpg'},'참여 연결 주문 = 그 공고 썸네일 · 다른 탭 주문에는 번지지 않는다');

  // SINGLE 은 참여 연결이 없는 작업(local-sheet/일반 시험) 주문 → 그 작업에 연결된 공고에서 찾는다(썸네일 있는 공고 우선)
  await h.pg.query("INSERT INTO recruit_campaigns(id,title,linked_sheet_id,linked_tab_name,thumbnail_url) VALUES('c-empty','빈 공고','local-sheet','일반 시험',''),('c-thumb','일반 공고','local-sheet','일반 시험','https://thumbnail.coupangcdn.com/b.jpg')");
  assert.equal((await thumbs(h))[SINGLE],'https://thumbnail.coupangcdn.com/b.jpg');

  for(const bad of ['http://plain.example/a.jpg','javascript:alert(1)','https://a b.jpg','https://x/"onerror=1','/api/order/guide-image/x','https://'+'a'.repeat(2050)]){
   await h.pg.query("UPDATE recruit_campaigns SET thumbnail_url=$1 WHERE id='local-campaign'",[bad]);
   assert.equal((await thumbs(h))[BUNDLE],null,'싣지 않음: '+bad.slice(0,40));
  }

  // 조회가 실패해도(예: 칸이 없는 옛 표) 목록·사진 상태는 그대로, 사진만 빈 자리
  await h.pg.query('ALTER TABLE recruit_campaigns DROP COLUMN thumbnail_url');
  const list=await h.core.listForReviewer({session});
  assert.deepEqual(list.items.map(i=>[i.orderSubmissionId,i.thumbnailUrl,i.channels.length]).sort(),[[SINGLE,null,1],[BUNDLE,null,2]].sort());
  const r=await h.core.getForReviewer({session,orderSubmissionId:SINGLE});
  assert.equal(r.item.thumbnailUrl,null);
 }finally{await h.pg.close();}
});
