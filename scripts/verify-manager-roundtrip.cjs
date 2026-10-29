// Local cross-repository integration only. In-memory PGlite + SQLite; all network requests deny nonfixture hosts.
// MANAGER_INADD_REPO may override the sibling inadd-manager-bidir checkout.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const RWS = path.resolve(__dirname, '..');
const INADD = process.env.MANAGER_INADD_REPO || path.resolve(RWS, '../inadd-manager-bidir');
const rwsRequire = createRequire(path.join(RWS, 'server/tests/managerBidirBackend.test.js'));
const { PGlite } = rwsRequire('@electric-sql/pglite');
const inaddNodeModules = path.join(INADD, 'node_modules/.bin/esbuild');
const scratch = process.env.MANAGER_SCRATCH_DIR || path.join(process.env.HOME, '.hermes/cache/scratch');
fs.mkdirSync(scratch, { recursive: true });
const bundle = path.join(scratch, 'manager-api-bundle.mjs');
execFileSync(inaddNodeModules, ['src/routes/api.ts', '--bundle', '--platform=node', '--format=esm', '--target=node26', `--outfile=${bundle}`], { cwd: INADD, stdio: 'inherit' });

function d1Adapter(db) {
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const result = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } }; },
      };
      return statement;
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const statement of statements) out.push(await statement.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
function expressRes() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; }, send(v) { this.body = v; return this; } };
}
function requestFor(handler, body, { params = {}, headers = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = expressRes();
    Promise.resolve(handler({ body, params, headers, query, admin: { role: 'admin', name: 'Fake manager integrator' } }, res, reject)).then(() => resolve(res), reject);
  });
}

async function main() {
  process.env.JWT_SECRET = 'local-manager-roundtrip-only';
  process.env.ORDER_INTAKE_KEY = 'local-intake-key';
  delete process.env.BIDIR_HARD_OFF;
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE work_orders (
      id TEXT PRIMARY KEY, source_review_order_id TEXT NOT NULL DEFAULT '', work_manager TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'reviewing', deleted_at TIMESTAMPTZ, linked_campaign_id TEXT NOT NULL DEFAULT '',
      sync_version BIGINT NOT NULL DEFAULT 10, intranet_acked_version BIGINT NOT NULL DEFAULT 0,
      source_revision INTEGER NOT NULL DEFAULT 2, intake_idempotency_key TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), workboard_schema_version SMALLINT NOT NULL DEFAULT 1,
      work_series_id TEXT NOT NULL DEFAULT '', work_round INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '', start_date DATE, product_option TEXT NOT NULL DEFAULT '', product_options_json TEXT NOT NULL DEFAULT '[]',
      pay_amount INTEGER NOT NULL DEFAULT 0, review_fee INTEGER NOT NULL DEFAULT 0, daily_count INTEGER NOT NULL DEFAULT 0,
      daily_count_text TEXT NOT NULL DEFAULT '', product_distribution_mode TEXT NOT NULL DEFAULT 'balanced', purchase_channel TEXT NOT NULL DEFAULT '',
      purchase_time TEXT NOT NULL DEFAULT '', inflow_keyword TEXT NOT NULL DEFAULT '', inflow_type TEXT NOT NULL DEFAULT '', inflow_guide TEXT NOT NULL DEFAULT '',
      guide_images TEXT NOT NULL DEFAULT '', thumbnail_url TEXT NOT NULL DEFAULT '', required_delivery_memo TEXT NOT NULL DEFAULT '',
      delivery_type TEXT NOT NULL DEFAULT '', courier_proxy BOOLEAN NOT NULL DEFAULT FALSE, review_type TEXT NOT NULL DEFAULT '',
      review_type_mix JSONB NOT NULL DEFAULT '[]', recruit_count INTEGER NOT NULL DEFAULT 0, review_guide TEXT NOT NULL DEFAULT '',
      special_notes TEXT NOT NULL DEFAULT '', product_url TEXT NOT NULL DEFAULT '', work_sheet_url TEXT NOT NULL DEFAULT '', goods_cost_type TEXT NOT NULL DEFAULT '',
      manager_name TEXT NOT NULL DEFAULT '', skip_weekends BOOLEAN, holidays TEXT, work_kind TEXT NOT NULL DEFAULT 'review', memo_log JSONB NOT NULL DEFAULT '[]',
      intranet_advertiser_name TEXT NOT NULL DEFAULT '', intranet_advertiser_contact TEXT NOT NULL DEFAULT '',
      intranet_advertiser_business_number TEXT NOT NULL DEFAULT '', sales_id TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '',
      contract_number TEXT NOT NULL DEFAULT '', intranet_advertiser_id TEXT NOT NULL DEFAULT '', purchase_channel_custom BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', source_work_order_id TEXT NOT NULL DEFAULT '', archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE work_order_shared_snapshots (work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL, origin TEXT NOT NULL, op_id TEXT NOT NULL DEFAULT '', state JSONB NOT NULL, actor TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(work_order_id,sync_version));
    CREATE TABLE shared_sync_outbox (id BIGSERIAL PRIMARY KEY, work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(work_order_id,sync_version));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    ALTER TABLE work_orders ADD COLUMN bidir_state TEXT NOT NULL DEFAULT 'off';
  `);
  await db.exec(fs.readFileSync(path.join(RWS, 'server/migrations/206_shared_sync_outbox_scope.sql'), 'utf8'));
  await db.query(`INSERT INTO app_settings(key,value) VALUES('bidir_sync',$1)`, [JSON.stringify({ push: 'on', in2rw: 'apply' })]);

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE review_orders (id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, requester_username TEXT NOT NULL, requester_name TEXT NOT NULL, sales_id TEXT NOT NULL DEFAULT '', contract_number TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '', intranet_advertiser_id TEXT NOT NULL DEFAULT '', source_revision INTEGER NOT NULL DEFAULT 1, workboard_schema_version INTEGER NOT NULL DEFAULT 1, work_series_id TEXT NOT NULL DEFAULT '', work_round INTEGER NOT NULL DEFAULT 1, remote_work_order_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER, remote_sync_version INTEGER NOT NULL DEFAULT 0, remote_manager_sync_version INTEGER NOT NULL DEFAULT 0, remote_shared_json TEXT NOT NULL DEFAULT '', rebase_needed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE review_order_outbox (id TEXT PRIMARY KEY, review_order_id TEXT NOT NULL, source_revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', remote_work_order_id TEXT NOT NULL DEFAULT '', last_attempt_at INTEGER, delivered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(review_order_id,source_revision));
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, department TEXT, is_active INTEGER DEFAULT 1, resigned_at INTEGER);
    INSERT INTO users(id,username,display_name,role,department) VALUES('fake-user','fake-owner','Fake owner','admin','');`);
  const D1 = d1Adapter(sqlite);
  const { default: api } = await import(bundle);
  const orderRouter = rwsRequire('../src/routes/order.routes');
  const handler = orderRouter.handlers.orderAdminEdit;
  const intakeLayer = orderRouter.stack.find(layer => layer.route && layer.route.path === '/intake/source/:sourceReviewOrderId' && layer.route.methods.put);
  assert.ok(intakeLayer, 'actual official RWS source PUT route exists');
  const intakeHandler = intakeLayer.route.stack[0].handle;
  const sharedLayer = orderRouter.stack.find(layer => layer.route && layer.route.path === '/intake/source/:sourceReviewOrderId/shared' && layer.route.methods.get);
  const sharedHandler = sharedLayer.route.stack[0].handle;
  const patchService = rwsRequire('../src/services/sharedPatch.service');
  const pusher = rwsRequire('../src/services/sharedSyncPush.service');
  const pool = rwsRequire('../src/db/pool');
  const dbQuery = db.query.bind(db);
  pool.query = async (sql, params) => /CREATE TABLE|ALTER TABLE|CREATE INDEX/.test(String(sql)) ? { rows: [] } : dbQuery(sql, params);
  pool.connect = async () => ({ query: dbQuery, release() {} });
  const rwsDb = { query: dbQuery, connect: pool.connect };

  const basePayload = (id, manager = '박세희') => ({
    source_system: 'inadd_intranet', source_review_order_id: id, source_revision: 2,
    idempotency_key: `seed:${id}:2`, workboard_schema_version: 1, work_series_id: `series-${id}`, work_round: 1,
    title: `Fake order ${id}`, start_date: '2026-10-29', product_option: '', product_options_json: '[]', pay_amount: 0, review_fee: 0,
    daily_count: 0, daily_count_text: '', product_distribution_mode: 'balanced', purchase_channel: '', purchase_time: '',
    inflow_keyword: '', inflow_type: '', inflow_guide: '', guide_images: [], thumbnail_url: '', required_delivery_memo: '',
    delivery_type: '', courier_proxy: false, review_type: '', review_type_mix: [], recruit_count: 0, review_guide: '', special_notes: 'unchanged note',
    product_url: '', work_sheet_url: '', goods_cost_type: '', manager_name: '', work_manager: manager, skip_weekends: false, holidays: [], work_kind: 'review',
  });
  async function seed(id, state) {
    const payload = basePayload(id);
    await db.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,status,sync_version,source_revision,title,special_notes,bidir_state,work_series_id,work_round,start_date,skip_weekends)
      VALUES($1,$2,$3,'reviewing',10,2,$4,$5,$6,$7,1,$8,false)`, [id, id, payload.work_manager, payload.title, payload.special_notes, state, payload.work_series_id, payload.start_date]);
    const orderRow = (await db.query('SELECT * FROM work_orders WHERE id=$1', [id])).rows[0];
    await db.query(`INSERT INTO work_order_shared_snapshots(work_order_id,sync_version,origin,state,actor) VALUES($1,10,'seed',$2::jsonb,'local fixture')`, [id, JSON.stringify(patchService.readSharedState(orderRow))]);
    await sqlite.prepare(`INSERT INTO review_orders(id,requester_id,requester_username,requester_name,sales_id,contract_number,quote_id,intranet_advertiser_id,source_revision,workboard_schema_version,work_series_id,work_round,remote_work_order_id,status,payload_json,created_at,updated_at,remote_sync_version,remote_manager_sync_version,remote_shared_json,rebase_needed)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'sent',?,?,?,0,0,'',0)`).run(id,'fake-user','fake-owner','Fake owner','','','','',2,1,payload.work_series_id,1,id,JSON.stringify(payload),Date.now(),Date.now());
    return payload;
  }

  const fetchLog = [];
  const officialIntakeBodies = [];
  const deliveredRequests = [];
  let failNextOfficialPut = false;
  async function localFetch(url, init = {}) {
    const parsed = new URL(String(url));
    fetchLog.push({ host: parsed.host, path: parsed.pathname, method: init.method || 'GET' });
    if (parsed.hostname === 'inadd.local' && parsed.pathname === '/review-order/webhook') deliveredRequests.push({ raw: String(init.body || ''), headers: new Headers(init.headers) });
    if (parsed.hostname === 'rws.local' && /^\/api\/order\/intake\/source\//.test(parsed.pathname) && failNextOfficialPut) { failNextOfficialPut = false; throw new Error('intentional local network outage'); }
    if (parsed.hostname === 'inadd.local' && parsed.pathname === '/review-order/webhook') {
      const response = await api.request('/review-order/webhook', new Request('http://inadd.local/review-order/webhook', init), {
        DB: D1, REVIEW_MEMO_KEY: 'local-review-key', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply', REVIEW_INTAKE_KEY: 'unused-local', REVIEW_API_BASE: 'http://rws.local',
      });
      if (!response.ok) console.error('receiver response', response.status, await response.clone().text());
      return response;
    }
    if (parsed.hostname === 'rws.local' && /^\/api\/order\/intake\/source\//.test(parsed.pathname)) {
      const sourceId = decodeURIComponent(parsed.pathname.split('/').at(-1));
      const body = JSON.parse(init.body || '{}');
      officialIntakeBodies.push(body);
      return invokeRwsIntake(body, sourceId);
    }
    throw new Error(`blocked non-local or unknown fetch: ${url}`);
  }
  // RWS Express handlers are called directly by the loopback HTTP adapter. Only serialization/network are adapted.
  async function invokeRwsIntake(body, sourceId) {
    const out = await requestFor(intakeHandler, body, { params: { sourceReviewOrderId: sourceId }, headers: { 'x-intake-key': 'local-intake-key' } });
    if (out.statusCode >= 400) console.error('RWS official source PUT rejected', out.statusCode, JSON.stringify(out.body));
    return new Response(JSON.stringify(out.body || {}), { status: out.statusCode, headers: { 'content-type': 'application/json' } });
  }
  global.fetch = localFetch;

  async function pushOnce() {
    return pusher.runSharedSyncPush({ db: rwsDb, env: {
      INTRANET_ORDER_DELETE_WEBHOOK_URL: 'http://inadd.local/review-order/webhook',
      BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', INTRANET_WEBHOOK_KEY: 'local-review-key',
    }, fetchImpl: localFetch });
  }
  const dbRow = async id => (await db.query('SELECT * FROM work_orders WHERE id=$1', [id])).rows[0];
  const d1row = async id => sqlite.prepare('SELECT * FROM review_orders WHERE id=?').get(id);

  // RWS -> Intranet: one manager-only OFF delivery and one ON full shared edit; official admin editor, real outbox/pusher, signed Hono receiver.
  for (const [id, state, target, withUnrelated] of [['rws-to-inadd-off','off','박은비',false], ['rws-to-inadd-prepublish','prepublish','박은비',false], ['rws-to-inadd-diverged','diverged','박은비',false], ['rws-to-inadd-separate','separate','박은비',false], ['rws-to-inadd-on','on','랜덤',true]]) {
    await seed(id, state);
    const before = await dbRow(id);
    const sharedResponse = await requestFor(sharedHandler, {}, { params: { sourceReviewOrderId: id }, headers: { 'x-intake-key': 'local-intake-key' }, query: { caps: 'manager' } });
    assert.equal(sharedResponse.body.capabilities.manager, true, `${state} advertises manager capability`);
    assert.ok(sharedResponse.body.writable.includes('work_manager'));
    if (state !== 'on') assert.deepEqual(sharedResponse.body.writable, ['work_manager'], `${state} exposes manager-only writable scope`);
    const editBody = { id, manager_capable: 1, manager_base_version: Number(before.sync_version), work_manager: target };
    if (withUnrelated) editBody.special_notes = 'ON unrelated edit';
    const edited = await requestFor(handler, editBody);
    assert.equal(edited.statusCode, 200, `RWS admin edit ${id}: ${JSON.stringify(edited.body)}`);
    const pushed = await pushOnce();
    assert.ok(pushed.delivered >= 1, `signed pusher delivered ${id}: ${JSON.stringify(pushed)}`);
    const afterRws = await dbRow(id), afterInadd = await d1row(id), payload = JSON.parse(afterInadd.payload_json);
    assert.equal(afterRws.work_manager, target);
    assert.equal(afterRws.bidir_state, state, 'manager edit does not force bidirectional state on');
    assert.equal(afterRws.title, before.title, 'manager-only edit preserves unrelated title');
    assert.equal(afterRws.special_notes, withUnrelated ? 'ON unrelated edit' : before.special_notes, 'only explicit ON unrelated edit changes its requested field');
    assert.equal(payload.work_manager, target, `${id} manager reached D1 through real signed receiver`);
    assert.equal(payload.title, `Fake order ${id}`);
    assert.equal(payload.special_notes, withUnrelated ? 'ON unrelated edit' : 'unchanged note');
    assert.equal(Number(afterInadd.remote_manager_sync_version) > 0, true);
    if (state !== 'on') assert.equal(Number(afterInadd.remote_sync_version), 0, `${state} scoped receipt leaves full watermark alone`);
    const received = deliveredRequests.at(-1);
    const sentPayload = JSON.parse(received.raw);
    if (state !== 'on') { assert.equal(sentPayload.scope, 'manager'); assert.deepEqual(sentPayload.view, { work_manager: target }); }
    else { assert.equal(sentPayload.view.work_manager, target); assert.equal(sentPayload.view.special_notes, 'ON unrelated edit'); }
    const duplicate = await api.request('/review-order/webhook', new Request('http://inadd.local/review-order/webhook', { method: 'POST', headers: received.headers, body: received.raw }), { DB: D1, REVIEW_MEMO_KEY: 'local-review-key', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply' });
    assert.equal((await duplicate.json()).result, 'stale', `${state} same-version replay is stale/idempotent`);
    const old = JSON.parse(received.raw); old.sync_version = Math.max(1, Number(old.sync_version) - 1); old.view.work_manager = '박세희';
    const oldRaw = JSON.stringify(old), t = Date.now(), signature = `t=${t},v1=${crypto.createHmac('sha256', 'local-bidir-secret').update(`${t}.${oldRaw}`).digest('hex')}`;
    const reordered = await api.request('/review-order/webhook', new Request('http://inadd.local/review-order/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Review-Key': 'local-review-key', 'X-Bidir-Signature': signature }, body: oldRaw }), { DB: D1, REVIEW_MEMO_KEY: 'local-review-key', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply' });
    assert.equal((await reordered.json()).result, 'stale', `${state} older reordered message is stale`);
    assert.equal(JSON.parse((await d1row(id)).payload_json).work_manager, target, 'old message does not roll back canonical manager');
  }

  // Pending intranet source edits hold shared pushes; after the local send completes the same durable message converges on retry.
  await seed('rws-held-convergence', 'off');
  await sqlite.prepare(`UPDATE review_orders SET status='queued' WHERE id=?`).run('rws-held-convergence');
  let beforeHeld = await dbRow('rws-held-convergence');
  let heldEdit = await requestFor(handler, { id: beforeHeld.id, manager_capable: 1, manager_base_version: Number(beforeHeld.sync_version), work_manager: '랜덤' });
  assert.equal(heldEdit.statusCode, 200);
  let heldPush = await pushOnce();
  assert.equal(heldPush.retry, 1, 'pending D1 local revision holds the inbound scoped message');
  assert.equal((await d1row('rws-held-convergence')).rebase_needed, 1);
  await sqlite.prepare(`UPDATE review_orders SET status='sent' WHERE id=?`).run('rws-held-convergence');
  await db.query(`UPDATE shared_sync_outbox SET next_at=NOW() WHERE work_order_id=$1 AND status='pending'`, ['rws-held-convergence']);
  heldPush = await pushOnce();
  assert.equal(heldPush.delivered, 1, 'held message converges after local send completes');
  assert.equal(JSON.parse((await d1row('rws-held-convergence')).payload_json).work_manager, '랜덤');

  // Intranet -> RWS: actual Hono PUT handler calls createReviewOrderSourceRevision/outbox; delivery adapter calls official RWS source PUT handler.
  for (const [id, state, target] of [['inadd-to-rws-off','off','박은비'], ['inadd-to-rws-on','on','랜덤']]) {
    const payload = await seed(id, state);
    const body = { ...payload, requester_username: 'fake-owner', work_manager: target,
      bidir: { manager: 1, base_sync_version: 10, op_id: `op-${id}` } };
    const response = await api.request(`/review-order/source/${encodeURIComponent(id)}`, new Request(`http://inadd.local/review-order/source/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { DB: D1, REVIEW_MEMO_KEY: 'local-review-key', REVIEW_INTAKE_KEY: 'local-intake-key', REVIEW_API_BASE: 'http://rws.local', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply' });
    const result = await response.json();
    assert.equal(response.status, 200, `actual Intranet PUT ${id}: ${JSON.stringify(result)}`);
    const after = await dbRow(id), d1 = await d1row(id), updated = JSON.parse(d1.payload_json);
    assert.equal(after.work_manager, target, `official RWS intake handler accepted manager ${id}`);
    assert.equal(Number(after.source_revision), 3, 'source revision increments exactly once');
    assert.equal(d1.source_revision, 3, 'D1 revision and sent outbox revision align');
    assert.ok(/^([a-f0-9]{64}|[a-zA-Z0-9:_-]+)$/.test(d1.idempotency_key), 'content key is present');
    assert.equal(updated.work_manager, target);
    assert.equal(updated.title, payload.title);
    assert.equal(updated.special_notes, payload.special_notes);
    const outbox = sqlite.prepare('SELECT source_revision,status,payload_json FROM review_order_outbox WHERE review_order_id=? ORDER BY source_revision DESC LIMIT 1').get(id);
    assert.equal(outbox.source_revision, 3); assert.equal(outbox.status, 'sent');
    if (id === 'inadd-to-rws-off') {
      const exactReplay = await invokeRwsIntake(officialIntakeBodies.at(-1), id);
      assert.equal(exactReplay.status, 200); assert.equal((await exactReplay.json()).idempotent, true, 'same revision and same content is idempotent');
      const conflictBody = { ...officialIntakeBodies.at(-1), title: 'different content at same revision', idempotency_key: 'different-key-same-revision' };
      const conflict = await invokeRwsIntake(conflictBody, id);
      assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'revision_already_applied', 'same source revision with different content hash is rejected');
    }
  }

  // Review P1: a delayed old RWS push must not undo a successful manager-only source save.
  // Exercise both the initial success and response-loss retry through the real source/outbox handlers.
  for (const loseResponse of [false, true]) {
    const id = `manager-ack-${loseResponse}`;
    const payload = await seed(id, 'off');
    const changed = await requestFor(handler, { id, manager_capable: 1, manager_base_version: 10, work_manager: '박은비' });
    assert.equal(changed.statusCode, 200);
    const delayed = pusher.buildPushBody(await dbRow(id), 'manager');
    const version = Number((await dbRow(id)).sync_version);
    let lost = false;
    const normalFetch = global.fetch;
    if (loseResponse) global.fetch = async (...args) => {
      const response = await normalFetch(...args);
      if (!lost && String(args[0]).includes(`/intake/source/${id}`)) { lost = true; throw new Error('intentional response loss after RWS commit'); }
      return response;
    };
    const env = { DB: D1, REVIEW_MEMO_KEY: 'local-review-key', REVIEW_INTAKE_KEY: 'local-intake-key', REVIEW_API_BASE: 'http://rws.local', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply' };
    const body = { ...payload, requester_username: 'fake-owner', work_manager: '랜덤', bidir: { manager: 1, base_sync_version: version } };
    const response = await api.request(`/review-order/source/${id}`, new Request(`http://inadd.local/review-order/source/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    assert.equal(response.status, loseResponse ? 202 : 200, JSON.stringify(await response.json()));
    global.fetch = normalFetch;
    if (loseResponse) {
      const retry = await api.request(`/review-order/source/${id}/retry`, new Request(`http://inadd.local/review-order/source/${id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requester_username: 'fake-owner' }) }), env);
      assert.equal(retry.status, 200, JSON.stringify(await retry.json()));
    }
    const acceptedVersion = Number((await dbRow(id)).sync_version);
    assert.equal((await d1row(id)).remote_manager_sync_version, acceptedVersion, 'manager-only source acknowledgement advances manager watermark');
    assert.equal((await d1row(id)).remote_sync_version, 0, 'manager-only source acknowledgement must not advance full watermark');
    const raw = JSON.stringify(delayed), t = Date.now();
    const received = await api.request('/review-order/webhook', new Request('http://inadd.local/review-order/webhook', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'X-Review-Key': 'local-review-key', 'X-Bidir-Signature': `t=${t},v1=${crypto.createHmac('sha256', 'local-bidir-secret').update(`${t}.${raw}`).digest('hex')}` } }), env);
    assert.equal((await received.json()).result, 'stale', 'delayed pre-save manager message is stale');
    assert.equal((await dbRow(id)).work_manager, '랜덤');
    assert.equal(JSON.parse((await d1row(id)).payload_json).work_manager, '랜덤');
    await pushOnce();
    assert.equal(JSON.parse((await d1row(id)).payload_json).work_manager, '랜덤', 'durable older outbox also cannot roll back saved manager');
  }
  console.log('review P1 manager acknowledgement + lost-response retry: PASS');

  // An injected local network failure leaves the durable source revision failed; the real retry route resends the same revision and converges.
  const retryPayload = await seed('inadd-delivery-retry', 'off');
  const retryBody = { ...retryPayload, requester_username: 'fake-owner', work_manager: '랜덤', bidir: { manager: 1, base_sync_version: 10, op_id: 'op-retry' } };
  failNextOfficialPut = true;
  const failedResponse = await api.request('/review-order/source/inadd-delivery-retry', new Request('http://inadd.local/review-order/source/inadd-delivery-retry', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(retryBody) }), { DB: D1, REVIEW_MEMO_KEY: 'local-review-key', REVIEW_INTAKE_KEY: 'local-intake-key', REVIEW_API_BASE: 'http://rws.local', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply' });
  assert.equal(failedResponse.status, 202);
  assert.equal(Number((await d1row('inadd-delivery-retry')).source_revision), 3);
  assert.equal((await sqlite.prepare('SELECT status FROM review_order_outbox WHERE review_order_id=? AND source_revision=3').get('inadd-delivery-retry')).status, 'failed');
  const retried = await api.request('/review-order/source/inadd-delivery-retry/retry', new Request('http://inadd.local/review-order/source/inadd-delivery-retry/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requester_username: 'fake-owner' }) }), { DB: D1, REVIEW_MEMO_KEY: 'local-review-key', REVIEW_INTAKE_KEY: 'local-intake-key', REVIEW_API_BASE: 'http://rws.local', BIDIR_RW_TO_IN_SECRET: 'local-bidir-secret', BIDIR_RECEIVE_MODE: 'apply' });
  assert.equal(retried.status, 200); assert.equal((await dbRow('inadd-delivery-retry')).work_manager, '랜덤');
  assert.equal((await sqlite.prepare('SELECT status FROM review_order_outbox WHERE review_order_id=? AND source_revision=3').get('inadd-delivery-retry')).status, 'sent');


  assert.ok(fetchLog.every(x => x.host === 'inadd.local' || x.host === 'rws.local'), 'network adapter saw local hosts only');
  assert.ok(fetchLog.some(x => x.path === '/review-order/webhook'), 'RWS -> Intranet crossed signed webhook route');
  assert.ok(fetchLog.some(x => /^\/api\/order\/intake\/source\//.test(x.path)), 'Intranet -> RWS crossed official source handler');
  console.log(JSON.stringify({ result: 'PASS', cases: ['RWS->Intranet OFF/prepublish/diverged/separate manager scope','RWS->Intranet ON full shared edit + unrelated field','signed replay/reordered stale protection','held then convergence','Intranet PUT->RWS OFF/ON actual revision/outbox/official intake','same revision hash conflict','manager source acknowledgement blocks delayed old push + response-loss retry','durable retry after injected network failure'], network: fetchLog, note: 'All DBs in memory; all fetches restricted to explicit loopback adapters.' }, null, 2));
  await db.close(); sqlite.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });