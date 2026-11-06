'use strict';
// Local-only HTTP harness for POST /api/submit/order and /review dual-channel branches.
// The pool module is replaced by a switchable proxy BEFORE any route/service is loaded,
// so every real module talks to the injected PGlite/stub database (never real PostgreSQL).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = randomBytes(32).toString('hex');

const SRC = path.resolve(__dirname, '../../src');
const ROUTE_FILE = path.join(SRC, 'routes/submit.routes.js');
const MIGRATION_215 = path.resolve(__dirname, '../../migrations/215_dual_channel_purchase_bundles.sql');

// ── switchable pool proxy ───────────────────────────────────────────────
const poolState = { impl: null, statements: [] };
const poolProxy = {
  query: async (sql, args) => {
    poolState.statements.push(String(sql));
    if (!poolState.impl) throw new Error('test pool not configured');
    return poolState.impl.query(sql, args);
  },
  connect: async () => {
    if (!poolState.impl) throw new Error('test pool not configured');
    const client = await poolState.impl.connect();
    return {
      ...client,
      query: async (sql, args) => { poolState.statements.push(String(sql)); return client.query(sql, args); },
      release: () => client.release && client.release(),
    };
  },
  on() {}, end: async () => {},
};
const poolPath = require.resolve(path.join(SRC, 'db/pool'));
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: poolProxy };
function usePool(impl) { poolState.impl = impl; poolState.statements = []; }
function statements() { return poolState.statements.slice(); }

const runtime = require(path.join(SRC, 'services/dualChannelRuntime.service'));
const ALL_READY = Object.fromEntries(['settings', 'roundtrip', 'recruitment', 'purchase', 'review', 'payment', 'operationalEnabled'].map(k => [k, true]));
const ready = () => runtime.__setReadinessForTest(ALL_READY);
const closed = () => runtime.__setReadinessForTest({});

// Load a router from source text with the real module resolution (memory-only copies).
function loadRouterFromSource(source) {
  const m = new Module(ROUTE_FILE, module);
  m.filename = ROUTE_FILE;
  m.paths = Module._nodeModulePaths(path.dirname(ROUTE_FILE));
  const fn = vm.runInThisContext(Module.wrap(source), { filename: ROUTE_FILE + '.vm.js' });
  fn.call(m.exports, m.exports, Module.createRequire(ROUTE_FILE), m, ROUTE_FILE, path.dirname(ROUTE_FILE));
  return m.exports;
}
function candidateSource() { return fs.readFileSync(ROUTE_FILE, 'utf8'); }
function baselineSource(rev = '123802a9') {
  return execFileSync('git', ['show', `${rev}:server/src/routes/submit.routes.js`], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
}

async function withApp(router, run) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/submit', router);
  app.use((err, req, res, next) => res.status(500).json({ error: '서버 오류', message: err && err.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/submit';
  const post = async (route, body, headers = {}) => {
    const response = await fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* raw */ }
    return { status: response.status, text, body: json };
  };
  try { return await run(post); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

// ── actual SQL fixture (PGlite) for the bundle order ───────────────────
const image = i => Buffer.from('local-fake-image-provider-bytes-' + i).toString('base64');
async function bundleFixture() {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  const db = {
    query: (sql, args) => pg.query(sql, args),
    exec: sql => pg.exec(sql),
    connect: async () => ({ query: (sql, args) => pg.query(sql, args), release() {} }),
  };
  await pg.exec(`CREATE TABLE reviewers(id uuid PRIMARY KEY,name text,phone text,phone8 text,address text,bank_name text,bank_account text,account_holder text,sub_accounts jsonb,shopping_id text,reviewer_no int);
 CREATE TABLE reviewer_delivery_addresses(id uuid,recipient text,address text,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identity_cards(id uuid,kind text,name_key text,phone8 text,status text,merged_into uuid,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identities(id uuid,member_no int,current_name text,current_phone text,current_phone8 text,shopping_id text,owner_reviewer_id uuid,status text);
 CREATE TABLE recruit_campaigns(id text PRIMARY KEY,multi_account_mode boolean,work_detail jsonb,channel text,channel_custom text,source_work_order_id text,linked_sheet_id text,linked_tab_name text,linked_tab_gid text,participation_mode boolean,status text,recruit_total int,updated_at timestamptz,workboard_id uuid,cash_receipt_required boolean DEFAULT false);
 CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,workboard_id uuid,capture_slots jsonb,income_type text,is_closed boolean DEFAULT false,archived_rounds text,sheetless boolean);
 CREATE TABLE campaign_options(campaign_id text,opt_key text,unit_kind text,product_name text);
 CREATE TABLE campaign_applications(id int PRIMARY KEY,campaign_id text REFERENCES recruit_campaigns(id),applicant_name text,applicant_phone text,phone8 text,owner_phone8 text,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,status text,expires_at timestamptz,hold_token text,order_submission_id uuid,review_fee_snapshot int,delivery_review_fee_mix_snapshot jsonb,blog_url text,purchase_qty int,qty_tier_amount int,option_key text,submitted_at timestamptz,late_order_id uuid,applied_at timestamptz DEFAULT now(),qna_slot_id int);
 CREATE TABLE reviewer_identity_match_audits(campaign_application_id int,owner_reviewer_id uuid,participant_identity_id uuid,selected_identity_hash text,image_hash text,extracted_fields_hash text,status text,approval_mode text,reason_codes jsonb);
 CREATE TABLE order_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,gid text,tab_gid text,orderer text,recipient text,user_id text,phone text,address text,order_num text,date_str text,bank text,account text,depositor text,price text,memo text,source text,dedup_key text,mirror_status text,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,participant_identity_key_hash text,deleted_at timestamptz,campaign_application_id int,campaign_was_late boolean DEFAULT false,review_fee_snapshot int,delivery_review_fee_mix_snapshot jsonb,blog_url text,purchase_qty int,qty_tier_amount int,capture_file_id text,capture_file_id_2 text,capture_flags jsonb,updated_at timestamptz,submitted_at timestamptz DEFAULT now(),sheet_row int,workboard_id uuid,selected_opt_key text,selected_product text,delivery_memo text,delivery_memo_check text,sheet_error text);
 CREATE TABLE review_submissions(id uuid PRIMARY KEY,file_id text);
 CREATE TABLE payment_batch_items(id uuid PRIMARY KEY,status text);`);
  const sql = fs.readFileSync(MIGRATION_215, 'utf8');
  await pg.exec(sql);
  const owner = randomUUID();
  const attacker = randomUUID();
  const product = { name: '상품', channels: { naver: { pay: 9000 }, coupang: { pay: 10000 } } };
  await db.query(`INSERT INTO reviewers VALUES($1,'김하나','01012345678','12345678','서울 강남대로 1 101호','은행','123','김하나','[]','id',1)`, [owner]);
  await db.query(`INSERT INTO reviewers VALUES($1,'남의사람','01099998888','99998888','부산 1','은행','999','남의사람','[]','id2',2)`, [attacker]);
  await db.query(`INSERT INTO recruit_campaigns(id,multi_account_mode,work_detail,channel,linked_sheet_id,linked_tab_name,linked_tab_gid,participation_mode,status,recruit_total) VALUES('camp',false,$1,'네이버+쿠팡','sheet','작업','',true,'active',3)`, [{ dualChannelProduct: product }]);
  // An ordinary campaign the attacker might name in the body.
  await db.query(`INSERT INTO recruit_campaigns(id,multi_account_mode,work_detail,channel,linked_sheet_id,linked_tab_name,linked_tab_gid,participation_mode,status,recruit_total) VALUES('plain',false,'{}','네이버','plain-sheet','일반','',true,'active',3)`);
  await db.query(`INSERT INTO campaign_applications(id,campaign_id,applicant_name,applicant_phone,phone8,owner_phone8,owner_reviewer_id,status,expires_at,hold_token,review_fee_snapshot) VALUES(7,'camp','김하나','01012345678','12345678','12345678',$1,'applied',now()+interval '1 hour','hold',2500)`, [owner]);
  const identity = require(path.join(SRC, 'services/reviewerOrderIdentity.service'));
  const lifecycle = require(path.join(SRC, 'services/dualChannelLifecycle.service'));
  const files = new Map(); let uploads = 0;
  const drive = {
    upload: async bytes => { const id = 'file-' + (++uploads); files.set(id, bytes); return id; },
    read: async id => files.get(id),
  };
  ready();
  const service = require(path.join(SRC, 'services/dualPurchaseSubmission.service')).createService({
    db, identity, drive, runtime, lifecycle, resolveFolder: async () => 'server-folder',
    extractAI: async () => ({ ok: true, data: {} }),
  });
  const body = { campaignApplicationId: 7, campaignHoldToken: 'hold', bank: '은행', account: '123', depositor: '김하나', purchases: {} };
  const reviewerSession = { ownerReviewerId: owner };
  async function stage(channel) {
    const imageBase64 = image(channel === 'naver' ? 1 : 11);
    const purchase = { orderNum: channel + '123456', userId: channel + '-id', recipient: '김하나', phone: '01012345678', address: '서울 강남대로 1 101호', paidAmount: product.channels[channel].pay };
    const extracted = { recipient: purchase.recipient, phone: purchase.phone, address: purchase.address, price: String(purchase.paidAmount) };
    const context = await identity.resolveApplicationIdentity({ ownerReviewerId: owner, applicationId: 7, campaignId: 'camp', holdToken: 'hold' }, db);
    const signed = require(path.join(SRC, 'services/dualPurchaseProof.service')).issueChannelExtraction({ context, channel, role: 'primary', revision: 1, imageBase64, extracted, ok: true });
    const approval = await identity.matchCapture({ applicationId: 7, campaignId: 'camp', holdToken: 'hold', extractToken: signed.extractToken, extracted }, reviewerSession);
    const artifact = await service.stagePurchaseArtifact({ body: { ...body, channel, role: 'primary', revision: 1, imageBase64, mimeType: 'image/png', extracted, extractionToken: signed.extractionToken, identityApprovalToken: approval.approvalToken, purchase }, reviewerSession });
    body.purchases[channel] = { ...purchase, primaryArtifactId: artifact.id };
    return artifact;
  }
  async function approve() {
    body.bundleApprovalToken = (await service.issueBundleApproval({ body, reviewerSession })).bundleApprovalToken;
    return body.bundleApprovalToken;
  }
  return { pg, db, owner, attacker, body, reviewerSession, service, identity, stage, approve, files, close: () => pg.close() };
}

module.exports = {
  SRC, ROUTE_FILE, usePool, statements, runtime, ready, closed, loadRouterFromSource, candidateSource, baselineSource,
  withApp, bundleFixture, image,
};
