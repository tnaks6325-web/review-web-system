'use strict';
/* 결정 349 ①②③ — 동시진행 직원 대리 묶음 제출 · 수동제출 보통 주문 보완 (PGlite 실제 SQL · 동시진행 fixture).
   외부 대역: Drive(메모리) · 리뷰어 자동등록(ensureExternalReviewer 호출 기록만) · 참여 신청 확정(실제 SQL INSERT 한 줄 —
   정원 계산은 이 시험 범위 밖) · 작업표 기록(호출 기록). 나머지(동시진행 판정·조건·명의 판정·증빙 SHA 잠금·
   구매처 기록·합계 검사·근거 해시·지급 보류 판정)는 실제 함수. */
require('./helpers/dualChannelDependencies.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { fixture } = require('./helpers/dualChannelRealFixture');
const PLAIN = '00000000-0000-4000-8000-0000000000b3';
const img = s => Buffer.from('image-' + s).toString('base64');
const FIELDS = { reviewerName: '가', recipient: '가', userId: 'uid', phone: '010-1234-5678', address: '서울 어딘가 1',
  bank: '국민', account: '123-456', depositor: '가', isSubAccount: false };

const OPEN = { settings: true, roundtrip: true, recruitment: true, purchase: true, review: true, payment: true, operationalEnabled: true };
const runtime = () => require(root + '/src/services/dualChannelRuntime.service');
async function setup() {
  const db = await fixture();
  runtime().__setReadinessForTest(OPEN);   // 운영 출시 상태와 같게(모든 키 열림)
  await db.exec(`
    ALTER TABLE order_submissions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE order_submissions ADD COLUMN orderer text, ADD COLUMN recipient text, ADD COLUMN user_id text, ADD COLUMN phone text,
      ADD COLUMN address text, ADD COLUMN order_num text, ADD COLUMN bank text, ADD COLUMN account text, ADD COLUMN depositor text,
      ADD COLUMN source text, ADD COLUMN dedup_key text, ADD COLUMN mirror_status text, ADD COLUMN tab_gid text, ADD COLUMN capture_flags jsonb,
      ADD COLUMN date_str text, ADD COLUMN capture_file_id text, ADD COLUMN submitted_at timestamptz DEFAULT now();
    ALTER TABLE campaign_applications ADD COLUMN phone8 text, ADD COLUMN status text;
    ALTER TABLE tab_configs ADD COLUMN income_type text;
    CREATE TABLE reviewers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone8 text,status text DEFAULT 'active');
    INSERT INTO reviewers(id,phone8) VALUES('00000000-0000-4000-8000-0000000000aa','12345678');
    INSERT INTO recruit_campaigns VALUES('normal','{}','s','other','',NULL);
  `);
  // 수동제출로 들어간 보통 주문 — 동시진행 작업표 3번 줄(쿠팡 쪽 10,000원 · 캡처 1장)
  await db.query(`INSERT INTO order_submissions(id,price,sheet_id,tab_name,gid,recipient,user_id,phone,address,order_num,source,capture_file_id,submitted_at)
    VALUES($1,'10000','s','t','g','가','uid','010-1234-5678','서울 어딘가 1','C-1','admin_external','cap-old',now()-interval '3 days')`, [PLAIN]);
  await db.query(`INSERT INTO campaign_participants(id,order_submission_id,sheet_id,tab_name,seq,row_json) VALUES(gen_random_uuid(),$1,'s','t',3,'{"결제금액":"10000"}')`, [PLAIN]);
  const files = new Map([['cap-old', Buffer.from('image-old')]]);
  const calls = { ensure: 0, apply: [], confirm: 0 };
  const svc = require(root + '/src/services/dualStaffSubmission.service').createService({
    db,
    drive: { upload: async b => { const id = 'f-' + (files.size + 1); files.set(id, Buffer.from(b)); return id; }, read: async id => files.get(id) },
    resolveFolder: async () => 'folder',
    ensureReviewer: async () => { calls.ensure++; return { registered: false, ownerPhone8: '12345678', warnings: [] }; },
    confirmApplication: async (client, a) => {
      calls.confirm++;
      const id = (await client.query('SELECT COALESCE(MAX(id),0)+1 AS id FROM campaign_applications')).rows[0].id;
      await client.query(`INSERT INTO campaign_applications(id,campaign_id,order_submission_id,phone8,status) VALUES($1,$2,$3,$4,'submitted')`, [id, a.campaignId, a.orderSubmissionId, a.phone8]);
      return { ok: true, applicationId: id };
    },
    applyWorktable: async a => { calls.apply.push(a); return { ok: true, seq: 4 }; },
  });
  return { db, svc, calls, files };
}
const count = async (db, sql, p = []) => (await db.query(sql, p)).rows[0].n;
const submitBody = (extra = {}) => ({ sheetId: 's', tabName: 't', gid: 'g', staff: { name: '망고' }, fields: FIELDS,
  naver: { orderNum: 'N-100200', paidAmount: '9,000', imageBase64: img('n') }, coupang: { orderNum: 'C-300400', paidAmount: 10000, imageBase64: img('c') }, ...extra });

test('① 대리 묶음 제출: 부모 1·구매처 기록 2·캡처 2·합계 금액 · 명의는 직원 확인 필요 · 작업표 기록 1회 · 재요청은 한 번만', async () => {
  const { db, svc, calls } = await setup();
  try {
    const r = await svc.submitStaffBundle(submitBody());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.price, 19000); assert.equal(r.identity, 'staff_pending');
    const o = (await db.query('SELECT * FROM order_submissions WHERE id=$1', [r.orderSubmissionId])).rows[0];
    assert.equal(o.purchase_bundle_version, 1); assert.equal(o.source, 'admin_external'); assert.equal(o.price, '19000');
    assert.equal(o.purchase_identity_result, 'uncertain'); assert.equal(o.purchase_identity_review.status, 'pending');
    assert.match(o.purchase_identity_review.submittedEvidenceHash, /^[0-9a-f]{64}$/);
    assert.equal(o.owner_reviewer_id, '00000000-0000-4000-8000-0000000000aa');
    assert.equal(await count(db, 'SELECT count(*)::int n FROM order_purchase_channels WHERE order_submission_id=$1', [o.id]), 2);
    assert.equal(await count(db, `SELECT count(*)::int n FROM purchase_capture_artifacts WHERE order_submission_id=$1 AND status='committed'`, [o.id]), 2);
    assert.equal((await db.query('SELECT order_submission_id FROM campaign_applications WHERE id=$1', [o.purchase_bundle_application_id])).rows[0].order_submission_id, o.id);
    assert.equal(calls.ensure, 1); assert.equal(calls.apply.length, 1);
    // 같은 요청 다시: 24시간 중복 판정(수동제출과 같은 함수)에 걸리고, 확인 후 강제(force)여도 같은 묶음 한 번뿐
    const again = await svc.submitStaffBundle(submitBody());
    assert.equal(again.ok, false); assert.equal(again.duplicate, true);
    const forced = await svc.submitStaffBundle(submitBody({ force: true, allowRepurchase: true }));
    assert.equal(forced.ok, true); assert.equal(forced.idempotent, true); assert.equal(forced.orderSubmissionId, o.id);
    assert.equal(await count(db, `SELECT count(*)::int n FROM order_submissions WHERE purchase_bundle_version=1`), 2);   // fixture 묶음 + 이번 1
    assert.equal(calls.apply.length, 1);
  } finally { await db.close(); }
});

test('① 지급 판정: 대리 묶음은 직원 명의 확인 전 지급 제외(identity_staff_pending)', async () => {
  const { db, svc } = await setup();
  try {
    const r = await svc.submitStaffBundle(submitBody());
    await db.query(`INSERT INTO campaign_participants(id,order_submission_id,sheet_id,tab_name,seq,row_json) VALUES(gen_random_uuid(),$1,'s','t',4,'{"결제금액":"19000"}')`, [r.orderSubmissionId]);
    const payout = require(root + '/src/services/dualChannelPayout.service');
    const e = await payout.evaluateOrderPayoutEligibility(db, { target: { orderSubmissionId: r.orderSubmissionId, sheetId: 's', tabName: 't', rowIndex: 4 },
      financialContext: async () => ({ bankName: '국민', bankAccount: '1', accountHolder: '가', reviewFee: 1000, payoutMode: 'ours', productPrice: 19000, reasons: [] }) });
    assert.ok(e.reasons.includes('identity_staff_pending'), JSON.stringify(e.reasons));
    assert.ok(!e.reasons.includes('purchase_channels_incomplete') && !e.reasons.includes('purchase_artifacts_incomplete') && !e.reasons.includes('purchase_total_mismatch'));
  } finally { await db.close(); }
});

test('② 거절: 동시진행 아닌 작업표 · 준비 상태 닫힘 · 캡처 한 장 · 수취인 다름 · 같은 사진 두 장 — 쓰기 0', async () => {
  const { db, svc, calls } = await setup();
  try {
    const before = await count(db, 'SELECT count(*)::int n FROM order_submissions');
    await assert.rejects(svc.submitStaffBundle(submitBody({ tabName: 'other', gid: '' })), e => e.code === 'dual_channel_required' && e.status === 409);
    runtime().__setReadinessForTest({});
    await assert.rejects(svc.submitStaffBundle(submitBody()), e => e.code === 'dual_channel_not_ready');
    runtime().__setReadinessForTest(OPEN);
    await assert.rejects(svc.submitStaffBundle(submitBody({ coupang: { orderNum: 'C-1', paidAmount: 10000 } })), e => e.code === 'DUAL_TWO_CAPTURES_REQUIRED');
    await assert.rejects(svc.submitStaffBundle(submitBody({ coupang: { orderNum: 'C-1', paidAmount: 10000, recipient: '나', imageBase64: img('c') } })), e => e.code === 'DUAL_IDENTITY_MISMATCH');
    await assert.rejects(svc.submitStaffBundle(submitBody({ coupang: { orderNum: 'C-1', paidAmount: 10000, imageBase64: img('n') } })), e => e.code === 'DUAL_IMAGE_REUSED');
    await assert.rejects(svc.submitStaffBundle(submitBody({ staff: {} })), e => e.code === 'STAFF_REQUIRED');
    assert.equal(await count(db, 'SELECT count(*)::int n FROM order_submissions'), before);
    assert.equal(calls.ensure, 0, '거절은 리뷰어 등록보다 앞');
  } finally { runtime().__setReadinessForTest(OPEN); await db.close(); }
});

test('② 입구: 대리 묶음 제출·보완은 수동제출과 같은 2단 권한 · Track B 는 같은 핸들러 위임 · 일반 수동제출의 결정 344 차단은 그대로', () => {
  const fs = require('node:fs');
  const mo = fs.readFileSync(root + '/src/routes/manualOrder.routes.js', 'utf8');
  const tb = fs.readFileSync(root + '/src/routes/trackB.routes.js', 'utf8');
  assert.match(mo, /router\.post\('\/dual\/submit', authMiddleware, adminOrMasterMiddleware,/);
  assert.match(tb, /router\.post\('\/manual-order\/dual\/submit', authMiddleware, internalMiddleware, editorOnlyMiddleware, \(req, res, next\) =>\s*_moDualSubmit\(req, res, next\)\)/);
  assert.equal((mo.match(/manualDualBlock\(pool,/g) || []).length, 2, '일반 미리보기·제출의 동시진행 차단 유지');
  const handlers = require(root + '/src/routes/manualOrder.routes').handlers;
  assert.equal(typeof handlers.manualOrderDualSubmit, 'function');
});
