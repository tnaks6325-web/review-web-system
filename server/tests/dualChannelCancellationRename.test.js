'use strict';
// Local SQL integration: actual shared lifecycle loaded read-only via explicit VM DI.
// This is a single-connection PGlite check, not a PostgreSQL concurrency claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const services = path.resolve(__dirname, '../src/services');
const lifecyclePath = process.env.DUAL_LIFECYCLE_MODULE || path.join(services, 'dualChannelLifecycle.service.js');
const lifecycle = require(lifecyclePath);
const OID = '11111111-2222-4333-8444-555555555555';
const OTHER = '11111111-2222-4333-8444-666666666666';
const canon = value => JSON.parse(JSON.stringify(value));
function load(name, overrides = {}, mutate = s => s) {
  const filename = path.join(services, name + '.service.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  if (name === 'tabRename' && process.env.CANCEL_RENAME_MUTANT === 'no-rename-transaction') {
    const originalMutate = mutate;
    mutate = s => {
      s = originalMutate(s);
      assert.equal(s.split("await client.query('BEGIN')").length - 1, 1);
      assert.equal(s.split("await client.query('ROLLBACK')").length - 1, 1);
      return s.replace("await client.query('BEGIN')", 'void 0').replace("await client.query('ROLLBACK')", 'void 0');
    };
  }
  vm.runInNewContext(mutate(fs.readFileSync(filename, 'utf8')), {
    module, exports: module.exports, console, process, Buffer, setTimeout, clearTimeout,
    require: id => Object.hasOwn(overrides, id) ? overrides[id]
      : id === './dualChannelLifecycle.service' ? lifecycle : localRequire(id),
  }, { filename });
  return module.exports;
}
async function fixture() {
  const sql = new PGlite();
  await sql.exec(`
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY, channel text, work_detail jsonb,
      source_work_order_id text, linked_sheet_id text, linked_tab_name text, linked_tab_gid text);
    CREATE TABLE campaign_applications(id int PRIMARY KEY, campaign_id text REFERENCES recruit_campaigns,
      status text, submitted_at timestamptz, order_submission_id uuid, late_order_id uuid);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, deleted_at timestamptz, canceled_by text,
      updated_at timestamptz, sheet_row int, mirror_status text, sheet_id text, tab_name text, tab_gid text, gid text,
      campaign_application_id int, purchase_bundle_application_id int UNIQUE REFERENCES campaign_applications,
      purchase_bundle_version int, purchase_bundle_hash text, price text);
    CREATE TABLE sheet_row_claims(order_id uuid);
    CREATE TABLE review_reminder_states(order_submission_id uuid, review_status text, updated_at timestamptz);
    CREATE TABLE campaign_participants(id text PRIMARY KEY, seq int, reviewer_name text, is_submitted boolean,
      is_paid boolean, order_submission_id uuid, sheet_id text, tab_name text, tab_gid text,
      deleted_at timestamptz, active boolean, updated_at timestamptz, updated_by text);
    CREATE TABLE sync_queue(id int PRIMARY KEY, type text, payload jsonb, status text);
    INSERT INTO recruit_campaigns VALUES ('a','네이버+쿠팡',NULL,NULL,'s','old','g'),
      ('b','네이버+쿠팡',NULL,NULL,'s','new','g2'), ('c','네이버+쿠팡',NULL,NULL,'s','gid-alias','g'),
      ('ordinary','네이버',NULL,NULL,'other','old','g');
    INSERT INTO campaign_applications VALUES (1,'a','submitted',now(),'${OID}',NULL),
      (2,'ordinary','submitted',now(),'${OTHER}',NULL), (3,'a','cancelled',NULL,NULL,'${OID}');
    INSERT INTO order_submissions VALUES ('${OID}',NULL,NULL,NULL,5,'written','s','old','g','g',1,1,1,'original-hash','300'),
      ('${OTHER}',NULL,NULL,NULL,5,'written','other','old','g','g',2,NULL,NULL,NULL,'100');
    INSERT INTO sheet_row_claims VALUES ('${OID}'),('${OTHER}');
    INSERT INTO review_reminder_states VALUES ('${OID}','pending',NULL),('${OTHER}','pending',NULL);
    INSERT INTO campaign_participants VALUES ('row',5,'same',false,false,'${OID}','s','old','g',NULL,true,NULL,NULL),
      ('other-row',5,'same',false,false,'${OTHER}','other','old','g',NULL,true,NULL,NULL);
    INSERT INTO sync_queue VALUES (1,'order_append','{}','pending');
  `);
  const trace = [], events = [];
  let hook = null, clientNo = 0;
  const query = async (who, text, args) => {
    trace.push({ who, text: String(text), args });
    if (hook) {
      const intercepted = await hook(who, String(text), args);
      if (intercepted !== undefined) return intercepted;
    }
    const r = await sql.query(text, args);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  const pool = { query: (s,a) => query('pool',s,a), connect: async () => {
    const who = 'client-' + (++clientNo);
    return { query: (s,a) => query(who,s,a), release(error) { trace.push({ who, text: 'release', error: !!error }); } };
  } };
  const cancellation = load('orderCancellation', {
    '../db/pool': pool,
    '../utils/jobLock': {
      ...require('../src/utils/jobLock'),
      // Baseline-only adapter: old withJobLock cannot receive an injected pool.
      withJobLock: async (name, run) => {
        const c = await pool.connect();
        const keys = require('../src/utils/jobLock')._lockKeys(name);
        await c.query('SELECT pg_try_advisory_lock($1,$2) AS ok', keys);
        try { return await run(); }
        finally { await c.query('SELECT pg_advisory_unlock($1,$2)', keys); c.release(); }
      },
    },
    '../utils/sse': { emitOrderLedger: event => { events.push(event); trace.push({ who: 'sse', text: 'emit' }); } },
  }, process.env.CANCEL_RENAME_MUTANT === 'no-cancel-transaction'
    ? s => { assert(s.includes("await client.query('ROLLBACK')")); return s.replaceAll("await client.query('BEGIN')", 'void 0').replaceAll("await client.query('ROLLBACK')", 'void 0'); }
    : s => s);
  return { sql, pool, trace, events, cancellation, hook: fn => { hook = fn; },
    rows: async text => (await sql.query(text)).rows, close: () => sql.close() };
}
async function seedRename(f) {
  await f.sql.exec(`
    CREATE TABLE review_index(sheet_id text,tab_name text,tab_gid text,row_index int);
    INSERT INTO review_index VALUES ('s','old','g',5),('other','old','g',5);
    CREATE TABLE review_submissions(sheet_id text,tab_name text);
    CREATE TABLE review_inspections(sheet_id text,tab_name text);
    CREATE TABLE review_edit_requests(sheet_id text,tab_name text);
    CREATE TABLE review_report_links(sheet_id text,tab_name text);
    CREATE TABLE qna_slots(sheet_id text,tab_name text,updated_at timestamptz);
    CREATE TABLE payment_batches(id text PRIMARY KEY,historical_key text);
    CREATE TABLE payment_batch_items(id text PRIMARY KEY,batch_id text,sheet_id text,tab_name text,row_index int,status text,amount int);
    CREATE TABLE payment_records(sheet_id text,tab_name text,row_index int,status text,source_key text,amount int);
    CREATE TABLE index_master(sheet_id text,tab_name text,tab_gid text);
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,sheet_url text,updated_at timestamptz);
    CREATE TABLE work_orders(id text PRIMARY KEY,linked_tab_sheet_id text,linked_tab_name text,linked_tab_gid text,
      linked_campaign_id text, sync_version int,updated_at timestamptz);
    CREATE TABLE trackb_work_order_links(sheet_id text,tab_name text,work_order_id text,deleted_at timestamptz);
    INSERT INTO payment_batches VALUES ('h','historical-fee:proof'),('o',NULL);
    INSERT INTO payment_batch_items VALUES ('historical','h','s','old',5,'paid',300),('pending','o','s','old',6,'pending',300),('paid','o','s','old',7,'paid',300);
    INSERT INTO payment_records VALUES ('s','old',5,'PAID','historical-fee:proof',300);
    INSERT INTO work_orders VALUES ('1','s','old','g',NULL,7,'2026-11-01'),('2','s','old','different',NULL,8,'2026-11-01');
    INSERT INTO trackb_work_order_links VALUES ('s','old','1',NULL);
  `);
}
async function snapshot(f, tables) {
  const result = {};
  for (const table of tables) result[table] = await f.rows(`SELECT to_jsonb(t) snapshot FROM ${table} t ORDER BY to_jsonb(t)::text`);
  return result;
}
let passed = 0;
async function test(name, run) {
  if (process.env.CANCEL_RENAME_TEST && !name.includes(process.env.CANCEL_RENAME_TEST)) return;
  const f = await fixture();
  try { await run(f); passed++; console.log('PASS ' + name); }
  finally { await f.close(); }
}
(async () => {
  await test('cancel lifecycle precedes legacy job lock; same client callback; commit precedes SSE', async f => {
    let callbackClient;
    const otherBefore = await f.rows(`SELECT to_jsonb(o) snapshot FROM order_submissions o WHERE id='${OTHER}'`);
    const out = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: OID, pool: f.pool,
      beforeCancelCommit: async client => {
        callbackClient = client;
        await client.query("UPDATE campaign_participants SET active=false WHERE id='row'");
      } });
    assert.equal(out.ok, true);
    const locks = f.trace.filter(x => /pg_.*advisory.*lock\(/.test(x.text));
    assert.match(locks[0].text, /dual_channel_lifecycle/, 'lifecycle must precede legacy session lock');
    assert(locks.some(x => /pg_try_advisory_lock\(/.test(x.text)), 'legacy session job lock retained');
    assert.equal(new Set(locks.map(x => x.who)).size, 1, 'all locks use business client');
    assert(callbackClient);
    const writeClient = f.trace.find(x => /UPDATE order_submissions SET deleted_at/.test(x.text)).who;
    assert.equal(writeClient, locks[0].who);
    assert.equal(f.trace.filter(x => x.text === 'BEGIN').length, 1);
    assert(f.trace.findIndex(x => x.text === 'COMMIT') < f.trace.findIndex(x => x.text === 'emit'));
    assert.equal(f.events.length, 1);
    assert.deepEqual(await f.rows(`SELECT to_jsonb(o) snapshot FROM order_submissions o WHERE id='${OTHER}'`), otherBefore);
    assert.deepEqual(await f.rows('SELECT type,status FROM sync_queue'), [{ type: 'order_append', status: 'pending' }]);
    assert.deepEqual(await f.rows('SELECT status,order_submission_id,submitted_at FROM campaign_applications WHERE id=1'),
      [{ status: 'cancelled', order_submission_id: null, submitted_at: null }]);
    assert.equal((await f.rows(`SELECT purchase_bundle_application_id,purchase_bundle_hash,mirror_status FROM order_submissions WHERE id='${OID}'`))[0].purchase_bundle_application_id, 1);
    await assert.rejects(f.sql.query(`INSERT INTO order_submissions(id,purchase_bundle_application_id) VALUES ('77777777-2222-4333-8444-555555555555',1)`), /unique constraint/);
    assert.equal((await f.rows('SELECT count(*)::int n FROM sheet_row_claims'))[0].n, 2);
    const again = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: OID, pool: f.pool,
      beforeCancelCommit: () => { throw new Error('idempotent callback must not run'); } });
    assert.equal(again.alreadyCanceled, true);
    assert.equal(f.events.length, 1);
  });
  await test('rename locks old, new and gid-alias campaign scopes before any write on one client', async f => {
    await seedRename(f);
    const rename = load('tabRename', { './cashReceiptContext.service': { invalidateCashReceiptContext: () => f.trace.push({ who: 'cache', text: 'invalidate' }) } });
    const out = await rename.renameTabState(f.pool, { sheetId: 's', oldTabName: 'old', newTabName: 'new', tabGid: 'g' });
    assert(f.trace.findIndex(x => x.text === 'COMMIT') < f.trace.findIndex(x => x.text === 'invalidate'), 'pool rename retains post-commit cache invalidation');
    assert.equal(out.orderSubmissionsUpdated, 1);
    const locks = f.trace.filter(x => /dual_channel_lifecycle/.test(x.text));
    assert.deepEqual(locks.map(x => x.args[0]), ['a','b','c']);
    const firstWrite = f.trace.findIndex(x => /^\s*UPDATE/.test(x.text));
    assert(locks.every(x => f.trace.indexOf(x) < firstWrite));
    assert.equal(new Set(f.trace.filter(x => /^\s*UPDATE/.test(x.text) || /dual_channel_lifecycle/.test(x.text)).map(x => x.who)).size, 1);
    assert.equal(f.trace.filter(x => x.text === 'BEGIN').length, 1);
    assert.deepEqual(await f.rows('SELECT linked_tab_name,sync_version FROM work_orders ORDER BY id'),
      [{ linked_tab_name: 'new', sync_version: 7 }, { linked_tab_name: 'old', sync_version: 8 }]);
    assert.deepEqual(await f.rows('SELECT id,tab_name FROM payment_batch_items ORDER BY id'),
      [{ id: 'historical', tab_name: 'new' }, { id: 'paid', tab_name: 'old' }, { id: 'pending', tab_name: 'new' }]);
    assert.equal((await f.rows(`SELECT tab_name FROM order_submissions WHERE id='${OTHER}'`))[0].tab_name, 'old');
  });
  await test('row delete passes injected pool to real cancellation and rechecks row/order after lifecycle lock', async f => {
    let forwarded = false;
    const deletion = load('workdeskOrderDelete', {
      './qnaSlots.service': { isQnaTab: async () => false, isBoundRow: async () => false },
      './orderCancellation.service': { ...f.cancellation, cancelOrderSubmission: async args => {
        assert.equal(args.pool, f.pool, 'selected pool must reach cancellation'); forwarded = true;
        return f.cancellation.cancelOrderSubmission(args);
      } },
    });
    const out = await deletion.deleteWorkdeskOrderRow({ sheetId: 's', tabName: 'old', rowId: 'row', pool: f.pool, by: 'staff' });
    assert.equal(out.ok, true); assert(forwarded);
    const lockIndex = f.trace.findIndex(x => /dual_channel_lifecycle/.test(x.text));
    const recheck = f.trace.findIndex((x,i) => i > lockIndex && /SELECT.*seq[\s\S]*FOR UPDATE/.test(x.text));
    const firstWrite = f.trace.findIndex(x => /UPDATE order_submissions SET deleted_at/.test(x.text));
    assert(recheck > lockIndex && recheck < firstWrite, 'selected row must be locked and revalidated before cancellation mutation');
    const orderRowLock = f.trace.findIndex(x => /SELECT[\s\S]*FROM order_submissions[\s\S]*FOR UPDATE/.test(x.text));
    assert(orderRowLock > lockIndex && orderRowLock < recheck, 'keep the existing order-before-participant lower-lock order for ordinary callers too');
    assert.equal((await f.rows("SELECT active,deleted_at IS NOT NULL deleted FROM campaign_participants WHERE id='row'"))[0].deleted, true);
    assert.deepEqual(await f.rows("SELECT active,deleted_at FROM campaign_participants WHERE id='other-row'"), [{ active: true, deleted_at: null }]);
  });
  await test('cancellation rolls back the first successful SQL mutation when a later real SQL fails', async f => {
    const before = await snapshot(f, ['order_submissions','campaign_participants','campaign_applications','review_reminder_states','sheet_row_claims']);
    f.hook(async (who, text) => {
      if (/UPDATE review_reminder_states/.test(text)) await f.sql.query('UPDATE missing_cancel_step SET nope=1');
    });
    await assert.rejects(f.cancellation.cancelOrderSubmission({ orderSubmissionId: OID, pool: f.pool,
      beforeCancelCommit: client => client.query("UPDATE campaign_participants SET active=false WHERE id='row'") }), /missing_cancel_step/);
    assert(f.trace.some(x => /UPDATE order_submissions SET deleted_at/.test(x.text)));
    assert.deepEqual(await snapshot(f, Object.keys(before)), before, 'whole cancellation transaction must roll back, not merely the failing statement');
    assert.equal(f.events.length, 0);
  });
  await test('rename rolls back the first successful index update on a later real SQL error', async f => {
    await seedRename(f);
    const before = await snapshot(f, ['review_index','order_submissions','campaign_participants','recruit_campaigns','work_orders','payment_batch_items']);
    f.hook(async (who, text) => {
      if (/UPDATE review_submissions/.test(text)) await f.sql.query('UPDATE missing_rename_step SET nope=1');
    });
    await assert.rejects(load('tabRename').renameTabState(f.pool, { sheetId: 's', oldTabName: 'old', newTabName: 'new', tabGid: 'g' }), /missing_rename_step/);
    assert.deepEqual(await snapshot(f, Object.keys(before)), before);
  });
  await test('caller-owned rename joins a pg-like client, adds no locks or transaction controls, and caller rollback restores SQL', async f => {
    await seedRename(f);
    const before = await snapshot(f, ['review_index','order_submissions','recruit_campaigns','work_orders','payment_batch_items']);
    const targets = [{ sheetId: 's', tabName: 'old', tabGid: 'g' }, { sheetId: 's', tabName: 'new', tabGid: 'g' }];
    const scope = await lifecycle.discoverDualScope(f.pool, targets);
    const client = await f.pool.connect();
    client.connect = () => { throw new Error('PoolClient.connect must not be called'); };
    await client.query('BEGIN'); await lifecycle.lockDualScopeInTx(client, scope);
    const start = f.trace.length;
    const result = await load('tabRename').renameTabState(client,
      { sheetId: 's', oldTabName: 'old', newTabName: 'new', tabGid: 'g' }, { lockedScope: scope });
    assert.equal(result.orderSubmissionsUpdated, 1);
    assert(!f.trace.slice(start).some(x => /^(BEGIN|COMMIT|ROLLBACK|release)$/.test(x.text) || /pg_.*advisory/.test(x.text)));
    await client.query('ROLLBACK'); client.release();
    assert.deepEqual(await snapshot(f, Object.keys(before)), before);
  });
  await test('dual caller rename refuses missing, forged, or incomplete scope without late lifecycle locks', async f => {
    await seedRename(f);
    const rename = load('tabRename');
    const args = { sheetId: 's', oldTabName: 'old', newTabName: 'new', tabGid: 'g' };
    const client = await f.pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT 1 FROM campaign_participants WHERE id='row' FOR UPDATE");
    const start = f.trace.length;
    await assert.rejects(rename.renameTabState(client, args), e => e.code === 'dual_lifecycle_scope_required');
    await assert.rejects(rename.renameTabStateInTx(client, args, { lockedScope: { targets: [], campaignIds: [] } }), /Server discovered/);
    const incomplete = await lifecycle.discoverDualScope(client, [{ sheetId: 's', tabName: 'old', tabGid: 'g' }]);
    await assert.rejects(rename.renameTabStateInTx(client, args, { lockedScope: incomplete }), e => e.code === 'dual_lifecycle_scope_required');
    assert(!f.trace.slice(start).some(x => /^\s*UPDATE|pg_.*advisory/.test(x.text)), 'no writes or late upper locks');
    await client.query('ROLLBACK'); client.release();
  });
  await test('cancel InTx writes on caller client but emits nothing; caller rollback restores entire cancellation', async f => {
    const before = await snapshot(f, ['order_submissions','campaign_applications','review_reminder_states']);
    const scope = await lifecycle.discoverDualScope(f.pool, [{ orderSubmissionId: OID }]);
    const client = await f.pool.connect();
    await client.query('BEGIN'); await lifecycle.lockDualScopeInTx(client, scope);
    const start = f.trace.length;
    const out = await f.cancellation.cancelOrderSubmissionInTx(client, { orderSubmissionId: OID }, { lockedScope: scope });
    assert.equal(out.ok, true);
    assert(!f.trace.slice(start).some(x => /^(BEGIN|COMMIT|ROLLBACK|release)$/.test(x.text) || /dual_channel_lifecycle/.test(x.text)));
    assert.equal(f.events.length, 0);
    await client.query('ROLLBACK'); client.release();
    assert.deepEqual(await snapshot(f, Object.keys(before)), before);
  });
  await test('selected row reassigned while waiting cannot cancel either order or delete another row', async f => {
    let reassigned = false;
    f.hook(async (who, text) => {
      if (text === 'BEGIN' && !reassigned) {
        reassigned = true;
        await f.sql.query(`UPDATE campaign_participants SET order_submission_id='${OTHER}' WHERE id='row'`);
      }
    });
    const deletion = load('workdeskOrderDelete', {
      './qnaSlots.service': { isQnaTab: async () => false }, './orderCancellation.service': f.cancellation,
    });
    const out = await deletion.deleteWorkdeskOrderRow({ sheetId: 's', tabName: 'old', rowId: 'row', pool: f.pool });
    assert.equal(out.code, 'row_changed');
    assert((await f.rows('SELECT deleted_at FROM order_submissions')).every(x => x.deleted_at === null));
    assert((await f.rows('SELECT active,deleted_at FROM campaign_participants')).every(x => x.active && x.deleted_at === null));
    assert.equal(f.events.length, 0);
  });
  await test('ordinary cancellation and caller rename keep legacy results, row claims and unrelated work unchanged without upper locks', async f => {
    const out = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: OTHER, pool: f.pool });
    assert.equal(out.ok, true); assert.equal(out.cleared, false); assert.equal(out.campaignSeatReleased, 'ordinary');
    assert.equal((await f.rows(`SELECT mirror_status FROM order_submissions WHERE id='${OTHER}'`))[0].mirror_status, 'canceled');
    assert.equal((await f.rows(`SELECT deleted_at FROM order_submissions WHERE id='${OID}'`))[0].deleted_at, null);
    assert.equal((await f.rows(`SELECT count(*)::int n FROM sheet_row_claims WHERE order_id='${OTHER}'`))[0].n, 1);
    assert(!f.trace.some(x => /dual_channel_lifecycle/.test(x.text)));
    await seedRename(f);
    const client = await f.pool.connect();
    await client.query('BEGIN');
    const start = f.trace.length;
    await load('tabRename').renameTabState(client, { sheetId: 'other', oldTabName: 'old', newTabName: 'renamed', tabGid: 'g' });
    assert(!f.trace.slice(start).some(x => /^(BEGIN|COMMIT|ROLLBACK|release)$/.test(x.text) || /pg_.*advisory/.test(x.text)));
    await client.query('COMMIT'); client.release();
    assert.equal((await f.rows(`SELECT tab_name FROM order_submissions WHERE id='${OTHER}'`))[0].tab_name, 'renamed');
    assert.equal((await f.rows(`SELECT tab_name FROM order_submissions WHERE id='${OID}'`))[0].tab_name, 'old');
  });
  await test('unwritten cancellation still deletes only its own row claim and invalid or missing IDs stay no-ops', async f => {
    await f.sql.query(`UPDATE order_submissions SET mirror_status='failed',sheet_row=NULL WHERE id='${OTHER}'`);
    const out = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: OTHER, pool: f.pool });
    assert.equal(out.ok, true);
    assert.deepEqual(await f.rows('SELECT order_id FROM sheet_row_claims'), [{ order_id: OID }]);
    const before = await snapshot(f, ['order_submissions','campaign_applications']);
    const missing = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pool: f.pool });
    assert.equal(missing.alreadyCanceled, true);
    const invalid = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: 'malformed', pool: f.pool });
    assert.equal(invalid.code, 'invalid_order_id');
    assert.deepEqual(await snapshot(f, Object.keys(before)), before);
  });
  await test('cancel InTx refuses missing or forged dual scope without acquiring late lifecycle locks', async f => {
    const client = await f.pool.connect(); await client.query('BEGIN');
    await client.query("SELECT 1 FROM campaign_participants WHERE id='row' FOR UPDATE");
    const start = f.trace.length;
    await assert.rejects(f.cancellation.cancelOrderSubmissionInTx(client, { orderSubmissionId: OID }), e => e.code === 'dual_lifecycle_scope_required');
    await assert.rejects(f.cancellation.cancelOrderSubmissionInTx(client, { orderSubmissionId: OID }, { lockedScope: { targets: [{ orderSubmissionId: OID }] } }), /Server discovered/);
    assert(!f.trace.slice(start).some(x => /^\s*UPDATE|pg_.*advisory/.test(x.text)));
    await client.query('ROLLBACK'); client.release();
  });
  await test('job busy stays a no-write retry refusal (busy result injected, not a concurrency proof)', async f => {
    const before = await snapshot(f, ['order_submissions','campaign_applications']);
    f.hook(async (who, text) => /pg_try_advisory_lock\(/.test(text) ? { rows: [{ ok: false }], rowCount: 1 } : undefined);
    const out = await f.cancellation.cancelOrderSubmission({ orderSubmissionId: OID, pool: f.pool });
    assert.equal(out.code, 'concurrent_cancel');
    assert.deepEqual(await snapshot(f, Object.keys(before)), before);
    assert.equal(f.events.length, 0);
    assert(!f.trace.some(x => /^\s*UPDATE/.test(x.text)));
  });
  await test('provenance changed after lifecycle lock fails closed before job lock and business writes', async f => {
    const before = await snapshot(f, ['order_submissions','campaign_applications','recruit_campaigns']);
    let changed = false;
    f.hook(async (who, text) => {
      if (/dual_channel_lifecycle/.test(text) && !changed) {
        changed = true;
        await f.sql.query("UPDATE recruit_campaigns SET linked_tab_name='moved' WHERE id='a'");
      }
    });
    await assert.rejects(f.cancellation.cancelOrderSubmission({ orderSubmissionId: OID, pool: f.pool }), e => e.code === 'dual_scope_changed_retry');
    assert.deepEqual(await snapshot(f, Object.keys(before)), before);
    assert(!f.trace.some(x => /pg_try_advisory_lock\(|UPDATE order_submissions/.test(x.text)));
    assert.equal(f.events.length, 0);
  });
  await test('InTx publisher is explicitly deferred until successful outer commit', async f => {
    const scope = await lifecycle.discoverDualScope(f.pool, [{ orderSubmissionId: OID }]);
    const client = await f.pool.connect(); await client.query('BEGIN'); await lifecycle.lockDualScopeInTx(client, scope);
    const out = await f.cancellation.cancelOrderSubmissionInTx(client, { orderSubmissionId: OID }, { lockedScope: scope });
    assert.equal(f.events.length, 0);
    await client.query('COMMIT'); client.release();
    f.cancellation.publishOrderCancellationAfterCommit(OID, out);
    assert.equal(f.events.length, 1);
    assert(f.trace.findIndex(x => x.text === 'COMMIT') < f.trace.findIndex(x => x.text === 'emit'));
    f.cancellation.publishOrderCancellationAfterCommit(OID, { ok: true, alreadyCanceled: true });
    f.cancellation.publishOrderCancellationAfterCommit(OID, { ok: false });
    assert.equal(f.events.length, 1);
  });
  console.log(`dualChannelCancellationRename ${passed}/${passed} PASS`);
})().catch(e => { console.error(e); process.exitCode = 1; });
