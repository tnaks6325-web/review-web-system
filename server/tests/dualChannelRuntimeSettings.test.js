'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtimePath = path.resolve(__dirname, '../src/services/dualChannelRuntime.service.js');
test('server owned readiness is closed, exact true only, and finishing does not depend on recruitment switch', () => {
  assert.ok(fs.existsSync(runtimePath), 'runtime readiness service must exist');
  const r = require(runtimePath);
  r.__setReadinessForTest(null);
  assert.deepEqual(r.getDualChannelReadiness(), { version: 1, settings: false, roundtrip: false, recruitment: false, purchase: false, review: false, payment: false, operationalEnabled: false });
  assert.equal(r.isDualChannelReady('settings'), false);
  assert.throws(() => r.assertDualChannelReady('settings'), { code: 'dual_channel_not_ready' });
  assert.throws(() => r.isDualChannelReady('unknown'), /operation/i);
  r.__setReadinessForTest({ settings: 1, roundtrip: 'true', review: true, payment: true });
  assert.equal(r.isDualChannelReady('settings'), false);
  assert.equal(r.isDualChannelReady('review'), false, 'review code prerequisites are required');
  const ready = { settings: true, roundtrip: true, recruitment: true, purchase: true, review: true, payment: true, operationalEnabled: true };
  r.__setReadinessForTest(ready);
  assert.equal(r.isDualChannelReady('purchase'), true);
  r.__setReadinessForTest({ ...ready, operationalEnabled: false, recruitment: false });
  assert.equal(r.isDualChannelReady('purchase'), false);
  assert.equal(r.isDualChannelReady('review'), true);
  assert.equal(r.isDualChannelReady('payment'), true);
  r.__setReadinessForTest(null);
});

test('follow-up ordinary campaign UPDATE protects the dedicated JSON', () => {
  assert.ok(require('../src/services/campaignSharedSave.service').WD_SHARED_KEYS.includes('dualChannelProduct'));
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
  assert.match(source, /unnest\(ARRAY\[[^\]]*'dualChannelProduct'/);
});

const { PGlite } = require('@electric-sql/pglite');
const shared = require('../src/services/sharedPatch.service');
const product = () => ({ name: '새 상품', product_mode: 'none', options: [], base: { pay: 19000, count: 3, daily: 1 }, channels: {
  naver: { url: 'https://shop.example/n', pay: 9000, inflow_type: 'link' },
  coupang: { url: 'https://shop.example/c', pay: 10000, inflow_type: 'link' },
} });
test('actual intake handler stores a new dual order only through server settings DI and ignores forged normalized body', async () => {
  const r = require(runtimePath);
  const pool = require('../src/db/pool');
  const previousQuery = pool.query;
  const pg = new PGlite();
  process.env.ORDER_INTAKE_KEY = 'local-settings-test';
  try {
    // Fresh fake database, real handler SQL. Schema follows its actual INSERT
    // list; the established runtime DDL is also executed, not stubbed.
    const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/order.routes.js'), 'utf8');
    const columns = source.match(/INSERT INTO work_orders\s*\(([^)]+)\)\s*VALUES/)[1].split(',').map(s => s.trim());
    const ints = new Set(['pay_amount','review_fee','daily_count','recruit_count','source_revision','workboard_schema_version','work_round']);
    const bools = new Set(['courier_proxy','skip_weekends']);
    await pg.exec(`CREATE TABLE work_orders (${columns.map(k => `${k} ${ints.has(k) ? 'INTEGER' : bools.has(k) ? 'BOOLEAN' : 'TEXT'}${k === 'id' ? ' PRIMARY KEY' : ''}`).join(',')}, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    pool.query = (sql, params) => pg.query(sql, params);
    const router = require('../src/routes/order.routes');
    const handler = router.stack.find(l => l.route && l.route.path === '/intake' && l.route.methods.post).route.stack.at(-1).handle;
    const call = async (body, selectedHandler = handler, id = '') => {
      const res = { statusCode: 200, status(n) { this.statusCode=n; return this; }, json(value) { this.body=value; return this; } };
      let error;
      await selectedHandler({ body, params: { id }, headers: { 'x-intake-key': 'local-settings-test' } }, res, e => { error=e; });
      if (error) throw error;
      return res;
    };
    const body = { title: 'new dual', work_kind: 'review', recruit_count: 3, daily_count: 1, pay_amount: 57000, product_options_json: JSON.stringify([product()]), allowDualChannels: true, bidir: { dual_channel: 1 } };
    r.__setReadinessForTest(null);
    const denied = await call(body); assert.equal(denied.statusCode, 400); assert.equal(denied.body.code, 'dual_channel_not_ready');
    assert.equal((await pg.query('SELECT * FROM work_orders')).rows.length, 0);
    r.__setReadinessForTest({ settings: true });
    const result = await call({ ...body, _normalized_product_options_json: '[]' });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(JSON.parse(result.body.data.product_options_json)[0].channels.naver.pay, 9000);
    assert.equal((await pg.query('SELECT * FROM work_orders')).rows.length, 1);
    await pg.exec(`ALTER TABLE work_orders ADD COLUMN linked_campaign_id TEXT DEFAULT '', ADD COLUMN bidir_state TEXT DEFAULT 'off', ADD COLUMN advertiser_id TEXT DEFAULT ''`);
    const legacy = router.stack.find(l => l.route && l.route.path === '/intake/:id' && l.route.methods.put).route.stack.at(-1).handle;
    const old = product(); delete old.channels; old.url = 'https://shop.example/legacy';
    const revised = await call({ product_options_json: JSON.stringify([old]) }, legacy, result.body.data.id);
    assert.equal(revised.statusCode, 200, JSON.stringify(revised.body));
    assert.equal(JSON.parse(revised.body.data.product_options_json)[0].channels.naver.pay, 9000);
    old.url = 'https://shop.example/admin';
    const admin = await call({ id: result.body.data.id, product_options_json: JSON.stringify([old]) }, router.handlers.orderAdminEdit);
    assert.equal(admin.statusCode, 200, JSON.stringify(admin.body));
    assert.equal(JSON.parse(admin.body.data.product_options_json)[0].channels.naver.pay, 9000);
    r.__setReadinessForTest(null);
    const deniedEdit = await call({ product_options_json: JSON.stringify([old]) }, legacy, result.body.data.id);
    assert.equal(deniedEdit.body.code, 'dual_channel_not_ready');
  } finally { pool.query=previousQuery; await pg.close(); r.__setReadinessForTest(null); }
});

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE work_orders (id TEXT PRIMARY KEY, title TEXT DEFAULT '', status TEXT DEFAULT 'reviewing', deleted_at TIMESTAMPTZ,
    bidir_state TEXT DEFAULT 'on', sync_version BIGINT DEFAULT 1, intranet_acked_version BIGINT DEFAULT 0,
    linked_campaign_id TEXT DEFAULT '', product_options_json TEXT, product_option TEXT DEFAULT '',
    pay_amount INTEGER DEFAULT 57000, recruit_count INTEGER DEFAULT 3, daily_count INTEGER DEFAULT 1,
    work_kind TEXT DEFAULT 'review', updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT, source_work_order_id TEXT, work_detail JSONB DEFAULT '{}',
      archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_options (id INTEGER PRIMARY KEY, campaign_id TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE work_order_shared_snapshots (work_order_id TEXT, sync_version BIGINT, origin TEXT, op_id TEXT DEFAULT '', state JSONB, actor TEXT, PRIMARY KEY(work_order_id,sync_version));
    CREATE TABLE shared_sync_outbox (work_order_id TEXT, sync_version BIGINT, view_scope TEXT DEFAULT 'full', status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
      next_at TIMESTAMPTZ DEFAULT NOW(), last_error TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(work_order_id,sync_version));`);
  await pg.query(`INSERT INTO work_orders(id,product_options_json) VALUES ('wo',$1)`, [JSON.stringify([product()])]);
  const wo = (await pg.query('SELECT * FROM work_orders')).rows[0];
  await pg.query(`INSERT INTO work_order_shared_snapshots VALUES ('wo',1,'test','',$1::jsonb,'test')`, [JSON.stringify(shared.readSharedState(wo))]);
  const db = { query: (s,p) => pg.query(s,p), connect: async () => ({ query: (s,p) => pg.query(s,p), release() {} }) };
  return { pg, db };
}
test('real shared service persists product channels, preserves omission and rejects broken final total without quantity edits', async () => {
  const r = require(runtimePath);
  r.__setReadinessForTest({ settings: true, roundtrip: true });
  const { pg, db } = await fixture();
  try {
    const p = product(); p.channels.naver.pay = 8000; p.channels.coupang.pay = 11000;
    const save = (mine, baseVersion=1) => shared.applySharedPatch({ db, workOrderId: 'wo', baseVersion, origin: 'campaign', mine });
    const result = await save({ product_options_json: JSON.stringify([p]) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    let wo = (await pg.query('SELECT * FROM work_orders')).rows[0];
    assert.equal(JSON.parse(wo.product_options_json)[0].channels.naver.pay, 8000);
    assert.equal((await pg.query('SELECT * FROM shared_sync_outbox')).rows.length, 1);
    const old = structuredClone(p); delete old.channels; old.url = 'https://shop.example/new';
    const second = await save({ product_options_json: JSON.stringify([old]) }, Number(wo.sync_version));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    wo = (await pg.query('SELECT * FROM work_orders')).rows[0];
    assert.equal(JSON.parse(wo.product_options_json)[0].channels.naver.pay, 8000);
    const before = JSON.stringify(wo); p.base.pay = 1;
    const broken = await save({ product_options_json: JSON.stringify([p]) }, Number(wo.sync_version));
    assert.equal(broken.status, 409);
    assert.equal(JSON.stringify((await pg.query('SELECT * FROM work_orders')).rows[0]), before);
  } finally { await pg.close(); r.__setReadinessForTest(null); }
});

test('intranet independent product name is aligned before omitted channels are preserved', async () => {
  const r = require(runtimePath); r.__setReadinessForTest({ settings: true, roundtrip: true });
  const { pg, db } = await fixture();
  try {
    const p = product(); delete p.channels; p.name = '인트라넷 별도 이름'; p.url = 'https://shop.example/named';
    const result = await shared.applySharedPatch({ db, workOrderId: 'wo', baseVersion: 1, origin: 'intranet', nameMap: { '인트라넷 별도 이름': '새 상품' }, mine: { product_options_json: JSON.stringify([p]) } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const saved = JSON.parse((await pg.query('SELECT product_options_json FROM work_orders')).rows[0].product_options_json)[0];
    assert.equal(saved.name, '새 상품'); assert.equal(saved.channels.coupang.pay, 10000); assert.equal(saved.url, p.url);
  } finally { await pg.close(); r.__setReadinessForTest(null); }
});

test('existing ordinary work cannot be converted to dual through shared save', async () => {
  const r = require(runtimePath); r.__setReadinessForTest({ settings: true, roundtrip: true });
  const { pg, db } = await fixture();
  try {
    const ordinary = product(); delete ordinary.channels;
    await pg.query(`UPDATE work_orders SET product_options_json=$1`, [JSON.stringify([ordinary])]);
    const current = (await pg.query('SELECT * FROM work_orders')).rows[0];
    await pg.query(`UPDATE work_order_shared_snapshots SET state=$1::jsonb`, [JSON.stringify(shared.readSharedState(current))]);
    const result = await shared.applySharedPatch({ db, workOrderId: 'wo', baseVersion: 1, origin: 'campaign', mine: { product_options_json: JSON.stringify([product()]) } });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'new_dual_work_required');
    assert.deepEqual(JSON.parse((await pg.query('SELECT product_options_json FROM work_orders')).rows[0].product_options_json), [ordinary]);
  } finally { await pg.close(); r.__setReadinessForTest(null); }
});

test('real campaign projection writes full dual product with zero option rows and preserves campaign name', async () => {
  const r = require(runtimePath); r.__setReadinessForTest({ settings: true, roundtrip: true });
  const { pg, db } = await fixture();
  try {
    const p = product(); p.channels.naver.pay = 7000; p.channels.coupang.pay = 12000;
    await pg.query(`INSERT INTO recruit_campaigns(id,title,work_detail) VALUES ('camp','공고 별도 이름',$1::jsonb)`, [JSON.stringify({ other: 'preserved', dualChannelProduct: { ...product(), name: '공고 별도 이름' } })]);
    await pg.query('BEGIN');
    await shared.projectToCampaignInTx(db, { id: 'camp', participation_mode: false }, { product_options_json: JSON.stringify([p]), work_kind: 'review', recruit_count: 3, daily_count: 1 }, new Set(), true, { urlTouched: false });
    await pg.query('COMMIT');
    const wd = (await pg.query(`SELECT work_detail FROM recruit_campaigns WHERE id='camp'`)).rows[0].work_detail;
    const normalized = require('../src/services/productOptions.service').normalizeProductOptionsJson([{ ...p, name: '공고 별도 이름' }], { allowDualChannels: true }).value[0];
    assert.deepEqual(wd, { other: 'preserved', dualChannelProduct: normalized });
    assert.equal((await pg.query('SELECT * FROM campaign_options')).rows.length, 0);
  } finally { await pg.close(); r.__setReadinessForTest(null); }
});

test('shared second write SQL failure rolls back first order update, snapshots and outbox', async () => {
  const r = require(runtimePath); r.__setReadinessForTest({ settings: true, roundtrip: true });
  const { pg, db } = await fixture();
  try {
    const before = (await pg.query('SELECT * FROM work_orders')).rows;
    await pg.exec(`ALTER TABLE work_order_shared_snapshots ADD CONSTRAINT fail_second_write CHECK (sync_version = 1)`);
    const p = product(); p.channels.naver.url = 'https://shop.example/changed';
    await assert.rejects(shared.applySharedPatch({ db, workOrderId: 'wo', baseVersion: 1, origin: 'campaign', mine: { product_options_json: JSON.stringify([p]) } }), /fail_second_write/);
    assert.deepEqual((await pg.query('SELECT * FROM work_orders')).rows, before);
    assert.equal((await pg.query('SELECT * FROM work_order_shared_snapshots')).rows.length, 1);
    assert.equal((await pg.query('SELECT * FROM shared_sync_outbox')).rows.length, 0);
  } finally { await pg.close(); r.__setReadinessForTest(null); }
});
