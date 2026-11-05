'use strict';

// 공유 저장 서비스와 실제 SQL을 로컬 임베디드 PostgreSQL에서 실행한다.
// 운영 DB·실제 발송·다중 연결 동시성 검증은 아니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const service = require('../src/services/sharedPatch.service');
const pg = new PGlite();
const db = { connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };

const product = () => ({ name: '공유 저장 시험 상품', product_mode: 'none', options: [],
  base: { pay: 19000, count: 3, daily: 1 }, channels: {
    naver: { url: 'https://shop.example/n', pay: 9000, inflow_type: 'link' },
    coupang: { url: 'https://shop.example/c', pay: 10000, inflow_type: 'link' },
  } });

const setup = async products => {
  await pg.exec(`DROP TABLE IF EXISTS shared_sync_outbox, work_order_shared_snapshots, recruit_campaigns, work_orders;
    CREATE TABLE work_orders (
      id TEXT PRIMARY KEY, title TEXT DEFAULT '', status TEXT DEFAULT 'reviewing', deleted_at TIMESTAMPTZ,
      bidir_state TEXT DEFAULT 'on', sync_version BIGINT DEFAULT 1, intranet_acked_version BIGINT DEFAULT 0,
      linked_campaign_id TEXT DEFAULT '', product_options_json TEXT, product_option TEXT DEFAULT '',
      pay_amount INTEGER DEFAULT 57000, recruit_count INTEGER DEFAULT 3, daily_count INTEGER DEFAULT 1,
      work_kind TEXT DEFAULT 'review', updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT, source_work_order_id TEXT,
      archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE work_order_shared_snapshots (work_order_id TEXT, sync_version BIGINT, origin TEXT,
      op_id TEXT DEFAULT '', state JSONB, actor TEXT, PRIMARY KEY(work_order_id,sync_version));
    CREATE TABLE shared_sync_outbox (work_order_id TEXT, sync_version BIGINT, view_scope TEXT DEFAULT 'full',
      status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_at TIMESTAMPTZ DEFAULT NOW(),
      last_error TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(work_order_id,sync_version));`);
  await pg.query(`INSERT INTO work_orders(id,product_options_json) VALUES ('wo-dual-shared',$1)`, [JSON.stringify(products)]);
  const order = (await pg.query('SELECT * FROM work_orders')).rows[0];
  await pg.query(`INSERT INTO work_order_shared_snapshots(work_order_id,sync_version,origin,state)
    VALUES ($1,1,'test',$2::jsonb)`, [order.id, JSON.stringify(service.readSharedState(order))]);
};
const persisted = async () => ({
  order: (await pg.query('SELECT product_options_json,pay_amount,sync_version FROM work_orders')).rows[0],
  snapshots: (await pg.query('SELECT * FROM work_order_shared_snapshots ORDER BY sync_version')).rows,
  outbox: (await pg.query('SELECT * FROM shared_sync_outbox ORDER BY sync_version')).rows,
});
const save = mine => service.applySharedPatch({ db, workOrderId: 'wo-dual-shared', baseVersion: 1, origin: 'campaign', mine });
test.after(() => pg.close());

test('기존 단일구매 상품의 금액 변경은 계속 저장된다', async () => {
  const p = product(); delete p.channels;
  await setup([p]);
  p.base.pay = 18000;
  const result = await save({ product_options_json: JSON.stringify([p]) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const state = await persisted();
  assert.equal(JSON.parse(state.order.product_options_json)[0].base.pay, 18000);
  assert.equal(state.order.pay_amount, 54000);
  assert.equal(state.outbox.length, 1);
});

test('저장된 동시진행의 기본 금액만 바꾸어 구매처 합계를 깨뜨리지 못한다', async () => {
  const p = product();
  await setup([p]);
  const before = await persisted();
  p.base.pay = 1;
  const result = await save({ product_options_json: JSON.stringify([p]) });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'dual_channel_not_ready');
  assert.deepEqual(await persisted(), before, '오더·버전·스냅숏·전송 대기열이 전부 그대로여야 한다');
});

test('동시진행 설정을 빼는 요청도 기존 동시진행 저장본을 일반 상품으로 바꾸지 못한다', async () => {
  const p = product();
  await setup([p]);
  const before = await persisted();
  delete p.channels;
  const result = await save({ product_options_json: JSON.stringify([p]) });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'dual_channel_not_ready');
  assert.deepEqual(await persisted(), before);
});

test('일반 상품의 공유 저장에 동시진행 설정을 끼워 넣지 못한다', async () => {
  const p = product();
  const old = structuredClone(p); delete old.channels;
  await setup([old]);
  const before = await persisted();
  const result = await save({ product_options_json: JSON.stringify([p]) });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'dual_channel_not_ready');
  assert.deepEqual(await persisted(), before);
});

test('병합 중 새 설정이 생겨도 최종 상태 검사에서 막고 저장 원문을 유지한다', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = require.resolve('../src/services/sharedPatch.service');
  const source = fs.readFileSync(filename, 'utf8');
  const marker = '= applyWrites(theirs, p.mine, plan.writes);';
  assert.equal(source.split(marker).length, 2, '실제 병합 호출 한 곳만 시험 대역으로 바꾼다');
  const modified = source.replace(marker, `= (() => {
    const result = applyWrites(theirs, p.mine, plan.writes);
    const products = JSON.parse(result.next.product_options_json);
    products[0].channels = injectedChannels;
    result.next.product_options_json = JSON.stringify(products);
    return result;
  })();`);
  const mod = { exports: {} };
  vm.runInNewContext(modified, { module: mod, exports: mod.exports, require: createRequire(filename),
    process, Buffer, console, injectedChannels: product().channels }, { filename });
  const p = product(); delete p.channels;
  await setup([p]);
  const before = await persisted();
  p.base.pay = 18000;
  const result = await mod.exports.applySharedPatch({ db, workOrderId: 'wo-dual-shared', baseVersion: 1,
    origin: 'campaign', mine: { product_options_json: JSON.stringify([p]) } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'dual_channel_not_ready');
  assert.deepEqual(await persisted(), before);
});
