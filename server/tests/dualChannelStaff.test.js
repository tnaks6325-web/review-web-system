'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,id}=require('./helpers/dualChannelFixture');
test('staff confirmation binds current proof; amount CAS and second SQL failure roll back all values',async()=>{
 const db=await fixture();try{
 const staff=require('../src/services/dualChannelStaffReview.service');
 const base={db,orderSubmissionId:id,actor:'trusted-staff'};
 await db.exec('BEGIN');
 const confirmed=await staff.resolveBundleIdentityReviewInTx({...base,expectedBundleHash:'a'.repeat(64),expectedArtifactRevisions:{naver:1,coupang:1},decision:'confirmed',note:'주소 확인'});
 await db.exec('COMMIT'); assert.equal(confirmed.decision,'confirmed');
 const review=require('../src/services/dualChannelReview.service');
 assert.equal(confirmed.evidenceHash,review.identityEvidenceHash(await review.loadBundle(db,id)));
 await db.exec(`UPDATE purchase_capture_artifacts SET revision=2 WHERE channel='coupang'`);
 assert.notEqual(confirmed.evidenceHash,review.identityEvidenceHash(await review.loadBundle(db,id)));
 await db.exec(`UPDATE purchase_capture_artifacts SET revision=1 WHERE channel='coupang'`);
 await db.exec('BEGIN');
 const changed=await staff.amendBundlePurchaseAmountInTx({...base,channel:'naver',paidAmount:8000,expectedRevision:1});
 await db.exec('COMMIT');assert.equal(changed.price,18000);assert.equal(changed.revision,2);
 const parent=(await db.query('SELECT * FROM order_submissions WHERE id=$1',[id])).rows[0];
 assert.equal(parent.purchase_bundle_hash,'a'.repeat(64));
 assert.equal((await db.query('SELECT row_json FROM campaign_participants')).rows[0].row_json['결제금액'],'18000');
 await db.exec('BEGIN');await assert.rejects(staff.amendBundlePurchaseAmountInTx({...base,channel:'coupang',paidAmount:9999,expectedRevision:1}),/bundle_revision_changed/);await db.exec('ROLLBACK');
 // The child UPDATE succeeds before the next real SQL statement fails.
 await db.exec(`CREATE FUNCTION fail_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced second SQL failure'; END $$;CREATE TRIGGER reject_parent BEFORE UPDATE ON order_submissions FOR EACH ROW EXECUTE FUNCTION fail_parent()`);
 await db.exec('BEGIN');await assert.rejects(staff.amendBundlePurchaseAmountInTx({...base,channel:'coupang',paidAmount:1,expectedRevision:2}),/forced second SQL failure/);await db.exec('ROLLBACK');
 assert.equal((await db.query(`SELECT paid_amount FROM order_purchase_channels WHERE channel='coupang'`)).rows[0].paid_amount,10000);
 assert.equal((await db.query('SELECT price FROM order_submissions')).rows[0].price,18000);
 }finally{await db.close();}
});

test('staff amendment retires active total/channel overlays in the same transaction',async()=>{
 const db=await fixture();try{
 await db.query(`INSERT INTO participant_edits(sheet_id,tab_name,anchor_type,anchor_value,field,kind,value_text,created_by) VALUES('s','t','order',$1,'col:결제금액','text','999','old'),('s','t','manual','1','col:네이버 금액','text','999','old')`,[id]);
 await db.exec(`INSERT INTO raw_sheet_tabs VALUES('s','t','g','["결제금액","네이버 금액","쿠팡 금액","기타"]',NULL);INSERT INTO raw_sheet_rows VALUES('s','t','g',2,'["999","999","10000","keep"]')`);
 await db.exec('BEGIN');await require('../src/services/dualChannelStaffReview.service').amendBundlePurchaseAmountInTx({db,orderSubmissionId:id,actor:'staff',channel:'naver',paidAmount:8000,expectedRevision:1});await db.exec('COMMIT');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM participant_edits WHERE reverted_at IS NULL')).rows[0].n,0);
 assert.deepEqual((await db.query('SELECT cells FROM raw_sheet_rows')).rows[0].cells,['18000','8000','10000','keep']);
 }finally{await db.close();}
});
