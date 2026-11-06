'use strict';
// HTTP-level checks for the dual-channel (naver+coupang) final purchase submission and the
// old review completion guard. Real Express router + real reviewer JWT (random secret).
// DB = PGlite or an in-memory stub through the pool proxy — never real PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const h = require('./helpers/dualSubmitFixture');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');

const submission = require('../src/services/dualPurchaseSubmission.service');
const sheetless = require('../src/services/sheetlessOrder.service');
const queueApply = require('../src/services/workboardQueueApply.service');
const ALLOWED_KEYS = ['campaignApplicationId', 'campaignHoldToken', 'bundleApprovalToken', 'purchases', 'bank', 'account', 'depositor'];

function patch(obj, key, value) { const old = obj[key]; obj[key] = value; return () => { obj[key] = old; }; }
const router = () => require('../src/routes/submit.routes');
const tokenFor = (ownerReviewerId, extra = {}) => issueReviewerSession({ ownerReviewerId, loginName: '김하나', loginPhone8: '12345678', ...extra });
const dualBody = f => ({
  campaignApplicationId: String(f.body.campaignApplicationId),   // the reviewer UI sends the query-string value
  campaignHoldToken: f.body.campaignHoldToken,
  bundleApprovalToken: f.body.bundleApprovalToken,
  purchases: JSON.parse(JSON.stringify(f.body.purchases)),
  bank: f.body.bank, account: f.body.account, depositor: f.body.depositor,
});
const count = async (db, sql) => Number((await db.query(sql)).rows[0].n);
const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

test('readiness closed: dual final body is refused 409 with zero DB statements and no service call', async () => {
  h.closed();
  let calls = 0;
  const restore = patch(submission, 'prepareBundle', async () => { calls++; throw new Error('must not run'); });
  h.usePool({ query: async () => { throw new Error('no DB while closed'); }, connect: async () => { throw new Error('no DB'); } });
  try {
    await h.withApp(router(), async post => {
      const r = await post('/order', { campaignApplicationId: 7, campaignHoldToken: 'hold', bundleApprovalToken: 'x', purchases: {}, bank: 'b', account: 'a', depositor: 'd' },
        { 'x-reviewer-token': tokenFor('00000000-0000-4000-8000-000000000009') });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'dual_channel_not_ready');
      assert.equal(r.body.ok, false);
    });
    assert.equal(calls, 0);
    assert.equal(h.statements().length, 0);
  } finally { restore(); h.ready(); }
});

test('dual final body without a valid reviewer session is 401 and never reaches the service', async () => {
  h.ready();
  let calls = 0;
  const restore = patch(submission, 'prepareBundle', async () => { calls++; throw new Error('must not run'); });
  h.usePool({ query: async () => { throw new Error('no DB before auth'); }, connect: async () => { throw new Error('no DB'); } });
  const staff = jwt.sign({ role: 'admin', ownerReviewerId: 'x' }, process.env.JWT_SECRET);
  const forged = jwt.sign({ scope: 'reviewer_session', ownerReviewerId: 'x' }, 'other-secret', { issuer: 'review-web-system', audience: 'reviewer-app' });
  try {
    await h.withApp(router(), async post => {
      const body = { campaignApplicationId: 7, campaignHoldToken: 'hold', bundleApprovalToken: 'x', purchases: {}, bank: 'b', account: 'a', depositor: 'd',
        ownerReviewerId: 'x', reviewerSession: { ownerReviewerId: 'x' } };
      for (const headers of [{}, { 'x-reviewer-token': staff }, { 'x-reviewer-token': forged }, { authorization: 'Bearer ' + staff }]) {
        const r = await post('/order', body, headers);
        assert.equal(r.status, 401, JSON.stringify(headers));
        assert.equal(r.body.ok, false);
      }
    });
    assert.equal(calls, 0);
    assert.equal(h.statements().length, 0);
  } finally { restore(); }
});

test('actual SQL: final UI body creates one parent + two channels on the server-mapped worktable; forged fields ignored; retry idempotent; legacy path refused', async () => {
  const f = await h.bundleFixture();
  h.usePool(f.db);
  const seen = [];
  const writes = [];
  const restores = [
    patch(submission, 'prepareBundle', async args => { seen.push(args); return f.service.prepareBundle(args); }),
    patch(sheetless, 'writeOrderToWorktable', async args => { writes.push(args); return { ok: true }; }),
    patch(queueApply, 'resolveQueuedWorkboardTarget', async () => ({ enabled: false })),
  ];
  try {
    await f.stage('naver'); await f.stage('coupang'); await f.approve();
    const forged = { ...dualBody(f), campaignId: 'plain', ownerReviewerId: f.attacker, reviewerSession: { ownerReviewerId: f.attacker },
      purchaseBundle: { forged: true }, sheetId: 'plain-sheet', tabName: '일반', gid: '9', folderId: 'attacker' };
    await h.withApp(router(), async post => {
      // Another reviewer's genuine session cannot submit this application.
      const foreign = await post('/order', forged, { 'x-reviewer-token': tokenFor(f.attacker, { loginPhone8: '99998888' }) });
      assert.ok(foreign.status >= 400 && foreign.status < 500, foreign.text);
      assert.equal(await count(f.db, 'SELECT count(*) AS n FROM order_submissions'), 0);

      const token = tokenFor(f.owner);
      const first = await post('/order', forged, { 'x-reviewer-token': token });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.ok, true);
      assert.equal(first.body.campaignHold, 'confirmed');
      assert.match(first.body.orderSubmissionId, /^[0-9a-f-]{36}$/);
      assert.equal(first.body.captureSession, undefined);   // no legacy parent-photo session for bundles

      const args = seen.at(-1);
      assert.deepEqual(Object.keys(args.body).sort(), [...ALLOWED_KEYS].sort());
      assert.equal(args.body.campaignApplicationId, 7);
      assert.equal(args.reviewerSession.ownerReviewerId, f.owner);

      const parents = (await f.db.query('SELECT * FROM order_submissions')).rows;
      assert.equal(parents.length, 1);
      assert.equal(parents[0].id, first.body.orderSubmissionId);
      assert.equal(parents[0].sheet_id, 'sheet');
      assert.equal(parents[0].tab_name, '작업');
      assert.equal(parents[0].owner_reviewer_id, f.owner);
      assert.equal(parents[0].price, '19000');
      assert.equal(parents[0].purchase_bundle_application_id, 7);
      assert.equal(parents[0].campaign_application_id, 7);
      assert.equal(await count(f.db, 'SELECT count(*) AS n FROM order_purchase_channels'), 2);
      assert.equal(await count(f.db, `SELECT count(*) AS n FROM purchase_capture_artifacts WHERE status='committed' AND order_submission_id IS NOT NULL`), 2);
      assert.equal((await f.db.query('SELECT status FROM campaign_applications WHERE id=7')).rows[0].status, 'submitted');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].sheetId, 'sheet');
      assert.equal(writes[0].tabName, '작업');
      assert.equal(writes[0].orderSubmissionId, first.body.orderSubmissionId);

      const again = await post('/order', forged, { 'x-reviewer-token': token });
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.orderSubmissionId, first.body.orderSubmissionId);
      assert.equal(await count(f.db, 'SELECT count(*) AS n FROM order_submissions'), 1);
      assert.equal(await count(f.db, 'SELECT count(*) AS n FROM order_purchase_channels'), 2);

      // Legacy single body for the same dual application must not be answered "already submitted".
      const legacy = await post('/order', { campaignId: 'camp', campaignApplicationId: 7, holdToken: 'hold', loginPhone8: '12345678', loginName: '김하나',
        orderer: '김하나', recipient: '김하나', userId: 'id', phone: '01012345678', address: '서울', bank: '은행', account: '123', depositor: '김하나', price: '19000', orderNum: '1' },
      { 'x-reviewer-token': token });
      assert.equal(legacy.status, 409, legacy.text);
      assert.equal(legacy.body.code, 'dual_channel_bundle_required');
      assert.equal(legacy.body.alreadySubmitted, undefined);
    });
  } finally { restores.forEach(r => r()); await f.close(); }
});

test('legacy single purchase into a dual campaign (hold or direct form) is refused before any business write', async () => {
  const f = await h.bundleFixture();
  h.usePool(f.db);
  let ledgerCalls = 0;
  const ledger = require('../src/services/orderLedger.service');
  const restore = patch(ledger, 'createOrderLedgerEntry', async () => { ledgerCalls++; throw new Error('must not write'); });
  const legacy = { loginPhone8: '12345678', loginName: '김하나', orderer: '김하나', recipient: '김하나', userId: 'id', phone: '01012345678',
    address: '서울 강남대로 1 101호', bank: '은행', account: '123', depositor: '김하나', price: '19000', orderNum: 'n-1' };
  try {
    await h.withApp(router(), async post => {
      const start = h.statements().length;
      const hold = await post('/order', { ...legacy, campaignId: 'camp', campaignApplicationId: 7, holdToken: 'hold' }, { 'x-reviewer-token': tokenFor(f.owner) });
      assert.equal(hold.status, 409, hold.text);
      assert.equal(hold.body.code, 'dual_channel_bundle_required');
      const direct = await post('/order', { ...legacy, sheetId: 'sheet', tabName: '작업' });
      assert.equal(direct.status, 409, direct.text);
      assert.equal(direct.body.code, 'dual_channel_bundle_required');
      assert.deepEqual(h.statements().slice(start).filter(s => WRITE.test(s)), []);
    });
    assert.equal(ledgerCalls, 0);
    assert.equal(await count(f.db, 'SELECT count(*) AS n FROM order_submissions'), 0);
    assert.equal((await f.db.query('SELECT status FROM campaign_applications WHERE id=7')).rows[0].status, 'applied');
  } finally { restore(); await f.close(); }
});

// Byte-identical ordinary behaviour: baseline (commit 123802a9) vs candidate on the same stub DB.
function stub(handler) {
  const query = async (sql, args) => handler(String(sql), args);
  return { query, connect: async () => ({ query, release() {} }) };
}
const ordinaryOrder = { loginPhone8: '33334444', loginName: '홍길동', orderer: '홍길동', recipient: '홍길동', userId: 'u', phone: '01033334444',
  address: '서울 1', bank: '은행', account: '1', depositor: '홍길동', price: '9000', orderNum: 'o-1' };
const holdRow = over => ({ rows: [{ phone8: '33334444', option_key: null, owner_phone8: '33334444', status: 'applied', order_submission_id: null,
  late_order_id: null, sub_alive: false, late_alive: false, qna_slot_id: null, ...over }] });
const SCENARIOS = [
  ['verified hold already submitted', ordinaryOrder && { ...ordinaryOrder, campaignId: 'c1', campaignApplicationId: 1, holdToken: 'h' },
    sql => /FROM campaign_applications ca/.test(sql) ? holdRow({ status: 'submitted', order_submission_id: 'os-1', sub_alive: true }) : { rows: [] }],
  ['verified late hold', { ...ordinaryOrder, campaignId: 'c1', campaignApplicationId: 1, holdToken: 'h' },
    sql => /FROM campaign_applications ca/.test(sql) ? holdRow({ status: 'expired', late_order_id: 'os-late', late_alive: true }) : { rows: [] }],
  ['qna bound hold', { ...ordinaryOrder, campaignId: 'c1', campaignApplicationId: 1, holdToken: 'h' },
    sql => /FROM campaign_applications ca/.test(sql) ? holdRow({ qna_slot_id: 3 }) : { rows: [] }],
  ['applied hold then stop', { ...ordinaryOrder, campaignId: 'c1', campaignApplicationId: 1, holdToken: 'h', sheetId: 'S', tabName: 'T' },
    sql => { if (/FROM campaign_applications ca/.test(sql)) return holdRow(); throw new Error('stop-after-gate'); }],
  ['db down with hold', { ...ordinaryOrder, campaignId: 'c1', campaignApplicationId: 1, holdToken: 'h', sheetId: 'S', tabName: 'T' },
    () => { throw new Error('db down'); }],
  ['db down direct form', { ...ordinaryOrder, sheetId: 'S', tabName: 'T' }, () => { throw new Error('db down'); }],
  ['no scope', { ...ordinaryOrder }, () => ({ rows: [] })],
  ['direct form stop', { ...ordinaryOrder, sheetId: 'S', tabName: 'T' },
    sql => { if (/recruit_campaigns/.test(sql) || /reviewers WHERE phone8/.test(sql)) return { rows: [] }; throw new Error('stop-after-gate'); }],
];
const REVIEW_SCENARIOS = [
  ['missing params', {}, {}, () => ({ rows: [] })],
  ['no auth', { sheetId: 'S', tabName: 'T', rowIndex: 2 }, {}, () => ({ rows: [] })],
  ['staff, db down', { sheetId: 'S', tabName: 'T', rowIndex: 2 }, 'staff', () => { throw new Error('db down'); }],
  ['staff, empty rows', { sheetId: 'S', tabName: 'T', rowIndex: 2 }, 'staff', () => ({ rows: [] })],
];

test('ordinary single purchase and ordinary review responses are byte-identical to the baseline route', async () => {
  h.ready();
  const baseline = h.loadRouterFromSource(h.baselineSource());
  const candidate = router();
  const staff = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
  const results = [];
  for (const [name, body, handler] of SCENARIOS) {
    const out = [];
    for (const r of [baseline, candidate]) {
      h.usePool(stub(handler));
      out.push(await h.withApp(r, post => post('/order', body, { 'x-reviewer-token': tokenFor('00000000-0000-4000-8000-000000000003', { loginPhone8: '33334444' }) })));
      await new Promise(res => setTimeout(res, 20));
    }
    results.push(name);
    assert.equal(out[1].status, out[0].status, name);
    assert.equal(out[1].text, out[0].text, name);
  }
  for (const [name, body, auth, handler] of REVIEW_SCENARIOS) {
    const out = [];
    for (const r of [baseline, candidate]) {
      h.usePool(stub(handler));
      out.push(await h.withApp(r, post => post('/review', body, auth === 'staff' ? { authorization: 'Bearer ' + staff } : {})));
      await new Promise(res => setTimeout(res, 20));
    }
    assert.equal(out[1].status, out[0].status, name);
    assert.equal(out[1].text, out[0].text, name);
  }
  assert.equal(results.length, SCENARIOS.length);
});

test('old review completion without dual metadata on a bundle row is refused 409 with zero writes', async () => {
  const { fixture } = require('./helpers/dualChannelRealFixture');
  const db = await fixture();
  // Ordinary review tables so the old completion path can actually reach its board write.
  await db.exec(`CREATE TABLE IF NOT EXISTS review_closed_targets(sheet_id text,tab_name text,row_index int,resolution_id text,order_submission_id uuid,closed_at timestamptz,close_reason text,review_status text);
   DROP TABLE IF EXISTS tab_configs;  -- the shared real fixture now creates a narrower tab_configs; this test needs the legacy-completion columns
   CREATE TABLE IF NOT EXISTS tab_configs(sheet_id text,tab_name text,tab_gid text,capture_slots jsonb,income_type text,is_closed boolean DEFAULT false,archived_rounds text,sheetless boolean DEFAULT true,workboard_id uuid,review_type text,work_kind text,created_at timestamptz DEFAULT now(),workboard_schema_version integer,folder_url text);
   INSERT INTO tab_configs(sheet_id,tab_name) VALUES('s','t');
   CREATE TABLE IF NOT EXISTS index_master_archive(sheet_id text,tab_name text);
   CREATE TABLE IF NOT EXISTS index_master(sheet_id text,tab_name text,submitted_count int DEFAULT 0,row_count int DEFAULT 9);
   ALTER TABLE campaign_participants ADD COLUMN IF NOT EXISTS round text; ALTER TABLE campaign_participants ADD COLUMN IF NOT EXISTS review_participation_id uuid;
   CREATE TABLE IF NOT EXISTS reviewer_participations(id uuid,campaign_participant_id uuid,lifecycle_status text,review_obligation_status text,review_evidence jsonb,record_version int,updated_at timestamptz,index_snapshot jsonb);
   ALTER TABLE review_index ADD COLUMN IF NOT EXISTS round text; ALTER TABLE review_index ADD COLUMN IF NOT EXISTS built_at timestamptz;`);
  h.usePool(db);
  try {
    const staff = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
    await h.withApp(router(), async post => {
      const start = h.statements().length;
      for (const headers of [{ authorization: 'Bearer ' + staff }, { 'x-reviewer-token': tokenFor('00000000-0000-4000-8000-000000000002') }]) {
        const r = await post('/review', { sheetId: 's', tabName: 't', rowIndex: 2, value: '제출' }, headers);
        assert.equal(r.status, 409, r.text);
        assert.equal(r.body.code, 'dual_review_upload_required');
        assert.equal(r.body.ok, false);
      }
      assert.deepEqual(h.statements().slice(start).filter(s => WRITE.test(s)), []);
    });
    assert.equal((await db.query("SELECT is_submitted FROM review_index WHERE sheet_id='s' AND row_index=2")).rows[0].is_submitted, false);
    assert.equal((await db.query("SELECT is_submitted FROM campaign_participants WHERE sheet_id='s' AND seq=2")).rows[0].is_submitted, false);
  } finally { await db.close(); h.ready(); }
});

test('review completion transaction re-checks the bundle even when the early lookup failed', async () => {
  h.ready();
  const seen = [];
  let early = true;
  const handler = sql => {
    if (/purchase_bundle_version/.test(sql)) {
      if (early) { early = false; throw new Error('early lookup unavailable'); }
      return { rows: [{ id: '00000000-0000-4000-8000-0000000000aa' }] };
    }
    if (/FROM review_index ri/.test(sql)) return { rows: [{ capture_slots: null, income_type: '', is_submitted: false }] };
    return { rows: [] };
  };
  const query = async (sql, args) => { seen.push(String(sql)); return handler(String(sql), args); };
  h.usePool({ query, connect: async () => ({ query, release() {} }) });
  const staff = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
  await h.withApp(router(), async post => {
    const r = await post('/review', { sheetId: 'S', tabName: 'T', rowIndex: 2 }, { authorization: 'Bearer ' + staff });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.code, 'dual_review_upload_required');
  });
  assert.ok(seen.includes('ROLLBACK'));
  assert.equal(seen.includes('COMMIT'), false);
  assert.deepEqual(seen.filter(s => WRITE.test(s)), []);
});

test('reviewer UI query-string application id (canonical digits) reaches the same dual proof; other strings refused', async () => {
  const f = await h.bundleFixture();
  h.usePool(f.db);
  try {
    await f.stage('naver'); await f.stage('coupang');
    const asString = { ...f.body, campaignApplicationId: '7', campaignId: 'plain' };
    const approval = await f.service.issueBundleApproval({ body: asString, reviewerSession: f.reviewerSession });
    assert.match(approval.bundleApprovalToken, /\./);
    for (const bad of ['07', '7.0', ' 7', '7a', '']) {
      await assert.rejects(f.service.issueBundleApproval({ body: { ...f.body, campaignApplicationId: bad }, reviewerSession: f.reviewerSession }),
        e => e.code === 'DUAL_APPLICATION_INVALID', bad);
    }
  } finally { await f.close(); }
});

module.exports = { SCENARIOS };
