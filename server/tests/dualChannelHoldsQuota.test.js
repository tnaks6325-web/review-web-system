'use strict';
// Real SQL via PGlite. Advisory ordering is traced, NOT a multi-connection concurrency proof.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const serviceDir = path.join(__dirname, '../src/services');
const lifecycleFile = process.env.DUAL_LIFECYCLE_TEST_SOURCE || path.join(serviceDir, 'dualChannelLifecycle.service.js');
const lifecycle = require(lifecycleFile);
function load(name, pool, injected = {}, transform = s => s) {
  const filename = path.join(serviceDir, name + '.service.js');
  const realRequire = createRequire(filename), mod = { exports: {} };
  vm.runInNewContext(transform(fs.readFileSync(filename, 'utf8')), {
    module: mod, exports: mod.exports, process, console, Buffer, URL, setTimeout, clearTimeout,
    require(id) {
      if (id === '../db/pool') return pool;
      if (id === './dualChannelLifecycle.service') return lifecycle;
      if (id === '../utils/logger') return { logger: { info() {}, warn() {}, error() {} } };
      if (id === './reviewerEventLog.service') return { logReviewerEvent: async () => {} };
      if (Object.hasOwn(injected, id)) return injected[id];
      return realRequire(id);
    },
  }, { filename });
  return mod.exports;
}
async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY, participation_mode BOOLEAN DEFAULT TRUE,
      status TEXT DEFAULT 'active', recruit_total INT DEFAULT 1, source_work_order_id TEXT,
      linked_sheet_id TEXT, linked_tab_name TEXT, linked_tab_gid TEXT, archived_at TIMESTAMPTZ,
      work_detail JSONB DEFAULT '{}', channel TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_applications(id SERIAL PRIMARY KEY, campaign_id TEXT REFERENCES recruit_campaigns(id),
      status TEXT DEFAULT 'applied', expires_at TIMESTAMPTZ DEFAULT NOW()-INTERVAL '2 minutes',
      late_order_id UUID, order_submission_id UUID, dismissed_at TIMESTAMPTZ, dismissed_by TEXT,
      phone8 TEXT DEFAULT '11112222', owner_phone8 TEXT, hold_token TEXT DEFAULT 'token',
      submitted_at TIMESTAMPTZ, option_key TEXT, review_fee_snapshot INT, delivery_review_fee_mix_snapshot JSONB,
      blog_url TEXT, purchase_qty INT, qty_tier_amount INT);
    CREATE TABLE order_submissions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),campaign_application_id INT,
      deleted_at TIMESTAMPTZ,campaign_was_late BOOLEAN DEFAULT FALSE,review_fee_snapshot INT,
      delivery_review_fee_mix_snapshot JSONB,blog_url TEXT,purchase_qty INT,qty_tier_amount INT);
    CREATE TABLE work_orders(id TEXT PRIMARY KEY, linked_campaign_id TEXT, recruit_count INT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),deleted_at TIMESTAMPTZ);
    CREATE TABLE campaign_participants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),seq INT,
      sheet_id TEXT,tab_name TEXT,tab_gid TEXT,reviewer_name TEXT,recipient_name TEXT,phone8 TEXT,
      order_submission_id UUID,deleted_at TIMESTAMPTZ,active BOOLEAN DEFAULT TRUE,row_json JSONB,
      source TEXT,updated_by TEXT,updated_at TIMESTAMPTZ,workboard_id UUID);
    CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,sheetless BOOLEAN DEFAULT TRUE,workboard_id UUID,work_kind TEXT);
    CREATE TABLE workboards(id UUID PRIMARY KEY,state TEXT);
    CREATE TABLE campaign_options(id SERIAL PRIMARY KEY,campaign_id TEXT,opt_key TEXT,recruit_total INT,status TEXT,sort_order INT);
    CREATE TABLE campaign_rounds(campaign_id TEXT,round_no INT,slot_count INT);
    CREATE TABLE qna_slots(id UUID);
    CREATE TABLE review_submissions(id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE payment_batch_items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),status TEXT);
    INSERT INTO recruit_campaigns(id,work_detail) VALUES ('dual-a','{"dualChannelProduct":{}}'),('dual-b','{"dualChannelProduct":{}}'),('ordinary','{}');
    INSERT INTO campaign_applications(campaign_id) VALUES ('dual-a'),('dual-b'),('ordinary');
  `);
  const migrationFile = process.env.DUAL_BUNDLE_TEST_MIGRATION || path.join(__dirname, '../migrations/215_dual_channel_purchase_bundles.sql');
  await pg.exec(fs.readFileSync(migrationFile, 'utf8'));
  const calls = []; let tx = null, next = 0, connects = 0;
  const query = async (sql, params, who) => {
    const text = String(sql); calls.push({ sql: text, params, who, tx });
    if (/^BEGIN$/.test(text)) tx = ++next;
    // PostgreSQL's real advisory primitive is unavailable in WASM; trace only it.
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [], rowCount: 1 };
    const r = await pg.query(text, params);
    if (/^(COMMIT|ROLLBACK)$/.test(text)) tx = null;
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  const db = { query: (s,p) => query(s,p,'pool'), connect: async () => {
    connects++; const who = 'client-' + connects;
    return { query: (s,p) => query(s,p,who), release() {} };
  } };
  const injected = { './qnaSlots.service': { isQnaTab: async () => false },
    './quotaFloor.service': { campaignUsedFloor: async () => ({ known: true, total: 0 }), optionDirectOrders: async () => new Map() },
    './campaignState.service': { loadSequentialSchedule: async () => null },
    './campaignPlan.service': { relayCampaignWorktable: async () => ({ relayed: true }) },
    './sheetlessLedger.service': { rebuildLedgers: async () => ({ mirrorRows: 0, indexRows: 0 }) },
    './rowNumbering.service': { renumberTab: async () => ({ renumbered: true }) } };
  return { pg, db, calls, injected, hold: load('campaignHold',db), quota: load('linkedRecruitQuota',db,injected) };
}
function traceLifecycle(calls, campaignId) {
  return calls.findIndex(c => /dual_channel_lifecycle/.test(c.sql) && c.params[0] === campaignId);
}
test('sweep discovers unlocked, then lifecycle-before-app per campaign, not one global transaction', async () => {
  const f = await fixture();
  try {
    const result = await f.hold.sweepExpiredHolds(f.db);
    assert.equal(result.expired, 3);
    assert.equal(result.autoDismissed, 3);
    const locks = ['dual-a','dual-b'].map(id => traceLifecycle(f.calls,id));
    assert.ok(locks.every(i => i >= 0), 'each dual campaign must acquire lifecycle before mutating expiry');
    for (const [n,id] of ['dual-a','dual-b'].entries()) {
      const i = locks[n], lock = f.calls[i];
      const begin = f.calls.slice(0,i).findLastIndex(c => c.sql === 'BEGIN');
      assert.ok(begin >= 0);
      assert.ok(!f.calls.slice(begin,i).some(c => /FOR UPDATE|UPDATE campaign_applications/.test(c.sql)));
      const writes = f.calls.filter(c => /UPDATE campaign_applications/.test(c.sql) && c.who === lock.who);
      assert.ok(writes.length >= 3, id + ': expiry/backfill/dismiss execute on the locked client');
      assert.ok(f.calls.slice(i).some(c => c.who === lock.who && c.sql === 'COMMIT'));
    }
    assert.notEqual(f.calls[locks[0]].who,f.calls[locks[1]].who,'one checkout/transaction per campaign');
    const states = await f.pg.query('SELECT status,dismissed_by FROM campaign_applications');
    assert.ok(states.rows.every(r => r.status === 'expired' && r.dismissed_by === 'auto'));
  } finally { await f.pg.close(); }
});

test('quota sync wrappers acquire lifecycle before L1; InTx writes stay on caller client and roll back', async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`UPDATE recruit_campaigns SET source_work_order_id='wo-a' WHERE id='dual-a';
      INSERT INTO work_orders(id,linked_campaign_id,recruit_count) VALUES ('wo-a','dual-a',1);`);
    const out = await f.quota.syncCampaignRecruitTotal({ campaignId:'dual-a', recruitTotal:4, skipWorktable:true });
    assert.equal(out.recruitTotal,4);
    const life = traceLifecycle(f.calls,'dual-a');
    assert.ok(life >= 0,'quota must hold lifecycle before L1');
    const l1 = f.calls.findIndex(c => c.params?.includes('recruit_campaign_wo:wo-a'));
    assert.ok(l1 > life);
    f.calls.length = 0;
    await f.quota.syncWorkOrderRecruitTotal({ workOrderId:'wo-a', recruitTotal:5 });
    assert.ok(traceLifecycle(f.calls,'dual-a') >= 0);
    assert.ok(f.calls.findIndex(c => c.params?.includes('recruit_campaign_wo:wo-a')) > traceLifecycle(f.calls,'dual-a'));
    assert.equal(typeof f.quota.syncCampaignRecruitTotalInTx,'function');
    assert.equal(typeof f.quota.syncWorkOrderRecruitTotalInTx,'function');
    const scope = await lifecycle.discoverDualScope(f.db,[{campaignId:'dual-a'}]);
    const client = await f.db.connect();
    await client.query('BEGIN'); await lifecycle.lockDualScopeInTx(client,scope);
    f.calls.length = 0;
    await f.quota.syncCampaignRecruitTotalInTx(client,{campaignId:'dual-a',recruitTotal:9,skipWorktable:true,lockedScope:scope});
    await f.quota.syncWorkOrderRecruitTotalInTx(client,{workOrderId:'wo-a',recruitTotal:9,lockedScope:scope});
    assert.ok(!f.calls.some(c => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql)),'InTx never owns transaction');
    assert.ok(f.calls.every(c => c.who !== 'pool'),'no pool escape');
    await assert.rejects(client.query('INSERT INTO work_orders(id) VALUES (NULL)'),/null/i);
    await client.query('ROLLBACK'); client.release();
    assert.equal((await f.pg.query("SELECT recruit_count FROM work_orders WHERE id='wo-a'")).rows[0].recruit_count,4);
    assert.equal((await f.pg.query("SELECT recruit_total FROM recruit_campaigns WHERE id='dual-a'")).rows[0].recruit_total,5);
  } finally { await f.pg.close(); }
});

async function seedWorktable(f, quota = 2, count = 1) {
  await f.pg.query("UPDATE recruit_campaigns SET recruit_total=$1, linked_sheet_id='sheet',linked_tab_name='tab' WHERE id='dual-a'",[quota]);
  await f.pg.exec("INSERT INTO tab_configs(sheet_id,tab_name) VALUES ('sheet','tab')");
  for (let i=1;i<=count;i++) await f.pg.query("INSERT INTO campaign_participants(sheet_id,tab_name,seq,reviewer_name) VALUES ('sheet','tab',$1,$2)",[i,i===1?'buyer':'']);
}
test('replenish and overflow cleanup prelock lifecycle before tab/campaign rows and preserve protected rows', async () => {
  const f = await fixture();
  try {
    await seedWorktable(f,3,1);
    const added = await f.quota.replenishWorktableSlotsToLinkedQuota({sheetId:'sheet',tabName:'tab'});
    assert.equal(added.add,2);
    let i = traceLifecycle(f.calls,'dual-a');
    assert.ok(i >= 0,'refill prelocks lifecycle');
    assert.ok(f.calls.findIndex(c => c.params?.includes('sheetless_worktable:sheet:tab')) > i);
    await f.pg.exec("UPDATE recruit_campaigns SET recruit_total=1 WHERE id='dual-a'");
    f.calls.length=0;
    const cleaned = await f.quota.cleanupOverflowEmptyWorktableSlots({dryRun:false});
    assert.equal(cleaned.retired,2);
    i = traceLifecycle(f.calls,'dual-a');
    assert.ok(i >= 0,'cleanup prelocks lifecycle');
    assert.ok(f.calls.findIndex(c => /FOR UPDATE/.test(c.sql)) > i);
    assert.equal((await f.pg.query("SELECT COUNT(*)::int n FROM campaign_participants WHERE deleted_at IS NULL AND reviewer_name='buyer'")).rows[0].n,1);
    assert.equal(typeof f.quota.replenishWorktableSlotsToLinkedQuotaInTx,'function');
  } finally { await f.pg.close(); }
});

test('hold helpers require caller prelock, never acquire lifecycle after lower locks; caller rollback survives confirmation', async () => {
  const f=await fixture();
  try {
    await f.pg.exec("UPDATE campaign_applications SET expires_at=NOW()+INTERVAL '10 minutes' WHERE campaign_id='dual-a'");
    const order=(await f.pg.query('INSERT INTO order_submissions DEFAULT VALUES RETURNING id')).rows[0].id;
    const args={applicationId:1,campaignId:'dual-a',phone8:'11112222',holdToken:'token',orderSubmissionId:order,skipTabBinding:true};
    const client=await f.db.connect(); await client.query('BEGIN');
    await assert.rejects(f.hold.confirmHoldInTx(client,args),e=>e.code==='dual_lifecycle_prelock_required');
    assert.ok(!f.calls.some(c=>/UPDATE order_submissions/.test(c.sql)));
    await client.query('ROLLBACK');
    const lockedScope=await lifecycle.discoverDualScope(f.db,[{applicationId:1}]);
    await client.query('BEGIN'); await lifecycle.lockDualScopeInTx(client,lockedScope);
    f.calls.length=0;
    assert.equal(await f.hold.confirmHoldInTx(client,{...args,lockedScope}),'confirmed');
    assert.ok(!f.calls.some(c=>/dual_channel_lifecycle|^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql)),'caller-prelocked helper adds no upper lock or nested Tx');
    assert.equal((await client.query("SELECT status FROM recruit_campaigns WHERE id='dual-a'")).rows[0].status,'closed');
    await client.query('ROLLBACK');client.release();
    assert.equal((await f.pg.query('SELECT campaign_application_id FROM order_submissions WHERE id=$1',[order])).rows[0].campaign_application_id,null);
    assert.equal((await f.pg.query("SELECT status FROM campaign_applications WHERE id=1")).rows[0].status,'applied');
  } finally { await f.pg.close(); }
});

test('dual sweep optional dismiss SQL failure rolls back only optional markers, preserving expiry and transaction', async () => {
  const f=await fixture();
  try {
    await f.pg.exec(`CREATE FUNCTION reject_dismiss() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.dismissed_by='auto' AND NEW.campaign_id='dual-a' THEN
        RAISE EXCEPTION 'injected optional dismiss failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_dismiss BEFORE UPDATE ON campaign_applications FOR EACH ROW EXECUTE FUNCTION reject_dismiss();`);
    const result=await f.hold.sweepExpiredHolds(f.db);
    assert.equal(result.expired,3);
    assert.equal((await f.pg.query('SELECT status FROM campaign_applications WHERE id=1')).rows[0].status,'expired','optional SQL error must not undo core expiry');
    assert.ok(f.calls.some(c=>/ROLLBACK TO SAVEPOINT hold_sweep_optional/.test(c.sql)));
  } finally { await f.pg.close(); }
});

test('quota preflight assertions also prelock, and a shared tab expands coverage before any lower lock', async () => {
  const f=await fixture();
  try {
    await f.pg.exec(`UPDATE recruit_campaigns SET linked_sheet_id='sheet',linked_tab_name='tab' WHERE id IN ('dual-a','dual-b');
      UPDATE recruit_campaigns SET source_work_order_id='wo-a' WHERE id='dual-a';
      INSERT INTO work_orders(id,linked_campaign_id,recruit_count) VALUES ('wo-a','dual-a',1);
      INSERT INTO campaign_options(campaign_id,opt_key,recruit_total,status) VALUES ('dual-a','product',1,'active');`);
    await f.quota.assertCampaignRecruitTotal({campaignId:'dual-a',recruitTotal:2});
    assert.ok(traceLifecycle(f.calls,'dual-a') >= 0,'campaign preflight assertion lifecycle first');
    assert.ok(traceLifecycle(f.calls,'dual-b') >= 0,'all dual campaigns that shared slot helpers can lock must be covered');
    f.calls.length=0;
    await f.quota.assertWorkOrderQuota({workOrderId:'wo-a',recruitTotal:2});
    const firstLower=f.calls.findIndex(c=>/FOR UPDATE/.test(c.sql)||c.params?.includes('recruit_campaign_wo:wo-a'));
    assert.ok(traceLifecycle(f.calls,'dual-a') >= 0 && traceLifecycle(f.calls,'dual-b') < firstLower);
  } finally { await f.pg.close(); }
});

test('an ordinary optionless campaign sharing a dual tab keeps its original allocation refusal', async () => {
  const f=await fixture();
  try {
    await f.pg.exec(`UPDATE recruit_campaigns SET linked_sheet_id='sheet',linked_tab_name='tab' WHERE id IN ('ordinary','dual-a');
      UPDATE recruit_campaigns SET source_work_order_id='wo-o' WHERE id='ordinary';
      INSERT INTO work_orders(id,linked_campaign_id,recruit_count) VALUES ('wo-o','ordinary',1);`);
    await assert.rejects(f.quota.syncWorkOrderRecruitTotal({workOrderId:'wo-o',recruitTotal:2}),e=>e.code==='recruit_quota_no_active_option');
    assert.equal((await f.pg.query("SELECT recruit_total FROM recruit_campaigns WHERE id='ordinary'")).rows[0].recruit_total,1);
  } finally { await f.pg.close(); }
});

test('a link that changes after lifecycle preflight aborts rather than acquiring a new upper lock', async () => {
  const f=await fixture();
  try {
    await f.pg.exec("INSERT INTO work_orders(id,linked_campaign_id,recruit_count) VALUES ('wo-a','dual-a',1)");
    const connect=f.db.connect; let changed=false;
    f.db.connect=async()=>{
      const c=await connect(),query=c.query;
      c.query=async(s,p)=>{
        if (!changed && /SELECT id, linked_campaign_id FROM work_orders WHERE id=\$1 FOR UPDATE/.test(s)) {
          changed=true; await f.pg.exec("UPDATE work_orders SET linked_campaign_id='dual-b' WHERE id='wo-a'");
        }
        return query(s,p);
      };return c;
    };
    let error;
    try { await f.quota.syncWorkOrderRecruitTotal({workOrderId:'wo-a',recruitTotal:8}); } catch (e) { error=e; }
    assert.equal((await f.pg.query("SELECT recruit_total FROM recruit_campaigns WHERE id='dual-b'")).rows[0].recruit_total,1,'unlocked new campaign quota must never be persisted');
    assert.equal(traceLifecycle(f.calls,'dual-b'),-1,'never add a new lifecycle after L1');
    assert.ok(error && ['dual_scope_changed_retry','dual_lifecycle_prelock_required'].includes(error.code));
    assert.equal((await f.pg.query("SELECT linked_campaign_id FROM work_orders WHERE id='wo-a'")).rows[0].linked_campaign_id,'dual-a');
  } finally { await f.pg.close(); }
});

test('preservation: close/reopen use submitted count, respect manual closure, savepoint recovery and caller rollback', async () => {
  const f=await fixture();
  try {
    const client=await f.db.connect();
    const lockedScope=await lifecycle.discoverDualScope(f.db,[{campaignId:'dual-a'}]);
    await client.query('BEGIN'); await lifecycle.lockDualScopeInTx(client,lockedScope);
    await client.query("UPDATE campaign_applications SET status='submitted' WHERE campaign_id='dual-a'");
    await f.hold.maybePersistClosed(client,'dual-a',{lockedScope});
    assert.equal((await client.query("SELECT status FROM recruit_campaigns WHERE id='dual-a'")).rows[0].status,'closed');
    await client.query("UPDATE recruit_campaigns SET recruit_total=2 WHERE id='dual-a'");
    assert.equal(await f.hold.maybeReopenAfterQuotaIncrease(client,'dual-a',1,{savepoint:true,lockedScope}),true);
    await client.query("UPDATE recruit_campaigns SET status='closed',recruit_total=3 WHERE id='dual-a'");
    assert.equal(await f.hold.maybeReopenAfterQuotaIncrease(client,'dual-a',2,{savepoint:true,lockedScope}),false,'manual closure before full is respected');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query("UPDATE work_orders SET recruit_count=5 WHERE id='absent'");
    assert.equal(await f.hold.maybeReopenAfterQuotaIncrease(client,'dual-a',1,{savepoint:true}),false,'missing prelock stays fail-soft without opening');
    await client.query('SELECT 1'); // SAVEPOINT recovery leaves transaction usable.
    await client.query('ROLLBACK');client.release();
    assert.equal((await f.pg.query("SELECT status,recruit_total FROM recruit_campaigns WHERE id='dual-a'")).rows[0].status,'active');
  } finally { await f.pg.close(); }
});

test('preservation: late backfill revives only automatic markers and global dismissal cap is not per campaign', async () => {
  const f=await fixture();
  try {
    await f.pg.exec(`UPDATE campaign_applications SET status='expired',dismissed_at=NOW(),dismissed_by='auto' WHERE id=1;
      INSERT INTO order_submissions(campaign_application_id) VALUES (1);
      INSERT INTO campaign_applications(campaign_id,status,dismissed_at,dismissed_by) VALUES ('dual-a','cancelled',NOW(),'admin');`);
    const result=await f.hold.sweepExpiredHolds(f.db);
    assert.equal(result.revived,1);
    const row=(await f.pg.query('SELECT status,late_order_id,dismissed_by FROM campaign_applications WHERE id=1')).rows[0];
    assert.equal(row.status,'expired'); assert.ok(row.late_order_id); assert.equal(row.dismissed_by,null);
    assert.equal((await f.pg.query('SELECT dismissed_by FROM campaign_applications WHERE id=4')).rows[0].dismissed_by,'admin');
    await f.pg.exec("DELETE FROM order_submissions; UPDATE campaign_applications SET late_order_id=NULL,status='cancelled',dismissed_at=NULL,dismissed_by=NULL");
    const old=process.env.CAMPAIGN_AUTO_DISMISS_CAP; process.env.CAMPAIGN_AUTO_DISMISS_CAP='2';
    const capped=load('campaignHold',f.db);
    if(old===undefined)delete process.env.CAMPAIGN_AUTO_DISMISS_CAP;else process.env.CAMPAIGN_AUTO_DISMISS_CAP=old;
    assert.equal((await capped.sweepExpiredHolds(f.db)).autoDismissed,2);
    assert.equal((await f.pg.query("SELECT COUNT(*)::int n FROM campaign_applications WHERE dismissed_by='auto'")).rows[0].n,2);
  } finally { await f.pg.close(); }
});

test('overflow candidate quota is re-read under locks; a concurrent increase does not retire now-needed blanks', async () => {
  const f=await fixture();
  try {
    await seedWorktable(f,1,3);
    const connect=f.db.connect;let changed=false;
    f.db.connect=async()=>{
      if(!changed){changed=true;await f.pg.exec("UPDATE recruit_campaigns SET recruit_total=3 WHERE id='dual-a'");}
      return connect();
    };
    const result=await f.quota.cleanupOverflowEmptyWorktableSlots({dryRun:false});
    assert.equal((await f.pg.query("SELECT COUNT(*)::int n FROM campaign_participants WHERE deleted_at IS NULL")).rows[0].n,3,'stale candidate quota must not retire needed blanks');
    assert.equal(result.retired,0);
  } finally { await f.pg.close(); }
});
