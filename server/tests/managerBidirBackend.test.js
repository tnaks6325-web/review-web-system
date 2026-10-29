'use strict';

// 담당자 전용 동기화: 로컬 PGlite 저장소로 실제 저장 서비스·관리자 라우트·서명 전송기를 묶어 검증한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

process.env.JWT_SECRET = 'manager-test-secret';
process.env.ORDER_INTAKE_KEY = 'manager-intake-test';
delete process.env.BIDIR_HARD_OFF;

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE work_orders (
      id TEXT PRIMARY KEY, source_review_order_id TEXT NOT NULL DEFAULT '', work_manager TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'reviewing', deleted_at TIMESTAMPTZ, linked_campaign_id TEXT NOT NULL DEFAULT '',
      sync_version BIGINT NOT NULL DEFAULT 0, intranet_acked_version BIGINT NOT NULL DEFAULT 0,
      source_revision INTEGER NOT NULL DEFAULT 0, intake_idempotency_key TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), workboard_schema_version SMALLINT NOT NULL DEFAULT 1,
      work_series_id TEXT NOT NULL DEFAULT '', work_round INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '', start_date DATE, product_option TEXT NOT NULL DEFAULT '', product_options_json TEXT NOT NULL DEFAULT '[]',
      pay_amount INTEGER NOT NULL DEFAULT 0, review_fee INTEGER NOT NULL DEFAULT 0, daily_count INTEGER NOT NULL DEFAULT 0,
      daily_count_text TEXT NOT NULL DEFAULT '', product_distribution_mode TEXT NOT NULL DEFAULT 'balanced', purchase_channel TEXT NOT NULL DEFAULT '',
      purchase_time TEXT NOT NULL DEFAULT '', inflow_keyword TEXT NOT NULL DEFAULT '', inflow_type TEXT NOT NULL DEFAULT '', inflow_guide TEXT NOT NULL DEFAULT '',
      guide_images TEXT NOT NULL DEFAULT '', thumbnail_url TEXT NOT NULL DEFAULT '', required_delivery_memo TEXT NOT NULL DEFAULT '',
      delivery_type TEXT NOT NULL DEFAULT '', courier_proxy BOOLEAN NOT NULL DEFAULT FALSE, review_type TEXT NOT NULL DEFAULT '',
      delivery_type_mix TEXT NOT NULL DEFAULT '', recall_courier TEXT NOT NULL DEFAULT '', recall_product TEXT NOT NULL DEFAULT '',
      review_type_mix JSONB NOT NULL DEFAULT '[]', recruit_count INTEGER NOT NULL DEFAULT 0, review_guide TEXT NOT NULL DEFAULT '',
      special_notes TEXT NOT NULL DEFAULT '', product_url TEXT NOT NULL DEFAULT '', work_sheet_url TEXT NOT NULL DEFAULT '', goods_cost_type TEXT NOT NULL DEFAULT '',
      manager_name TEXT NOT NULL DEFAULT '', skip_weekends BOOLEAN, holidays TEXT, work_kind TEXT NOT NULL DEFAULT 'review',
      intranet_advertiser_name TEXT NOT NULL DEFAULT '', intranet_advertiser_contact TEXT NOT NULL DEFAULT '',
      intranet_advertiser_business_number TEXT NOT NULL DEFAULT '', sales_id TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '',
      contract_number TEXT NOT NULL DEFAULT '', intranet_advertiser_id TEXT NOT NULL DEFAULT '', purchase_channel_custom BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', source_work_order_id TEXT NOT NULL DEFAULT '', linked_sheet_id TEXT NOT NULL DEFAULT '', linked_tab_name TEXT NOT NULL DEFAULT '', archived_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE work_order_shared_snapshots (
      work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL, origin TEXT NOT NULL, op_id TEXT NOT NULL DEFAULT '',
      state JSONB NOT NULL, actor TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (work_order_id, sync_version)
    );
    CREATE UNIQUE INDEX uq_wo_shared_snap_op ON work_order_shared_snapshots (op_id) WHERE op_id <> '';
    CREATE TABLE shared_sync_outbox (
      id BIGSERIAL PRIMARY KEY, work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (work_order_id, sync_version)
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations/206_shared_sync_outbox_scope.sql'), 'utf8'));
  await db.query(`INSERT INTO app_settings(key,value) VALUES ('bidir_sync', $1)`, [JSON.stringify({ in2rw: 'apply', push: 'on' })]);
  const insertOrder = async (id, state = 'off', extra = {}) => {
    await db.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,status,linked_campaign_id,sync_version,title)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, extra.sourceId === undefined ? `ro_${id}` : extra.sourceId,
      extra.manager || '박세희', extra.status || 'reviewing', extra.campaign || '', extra.version || 10, `가짜 ${id}`]);
    await db.query(`UPDATE work_orders SET bidir_state = $2 WHERE id = $1`, [id, state]).catch(() => {});
  };
  // 이 시나리오의 상태값은 기존 migration 196의 의미를 반영해 컬럼을 추가한다.
  await db.query(`ALTER TABLE work_orders ADD COLUMN bidir_state TEXT NOT NULL DEFAULT 'off'`);
  await db.query(`UPDATE work_orders SET bidir_state='on' WHERE id='wo-on'`);
  const service = require('../src/services/sharedPatch.service');
  const push = require('../src/services/sharedSyncPush.service');
  const switchReader = require('../src/utils/bidirSwitch');

  await insertOrder('wo-off', 'off');
  await insertOrder('wo-diverged', 'diverged');
  await insertOrder('wo-separate', 'separate');
  await insertOrder('wo-on', 'on');
  await insertOrder('wo-full-paused', 'off');
  for (const id of ['wo-off', 'wo-diverged', 'wo-separate']) {
    const row = (await db.query(`SELECT * FROM work_orders WHERE id=$1`, [id])).rows[0];
    const out = await service.applySharedPatch({
      db: { connect: async () => ({ query: db.query.bind(db), release() {} }) },
      workOrderId: id, mine: { work_manager: '박은비' }, baseVersion: Number(row.sync_version),
      origin: 'rw_manager', managerOnly: true, actor: '테스트 관리자',
    });
    assert.equal(out.status, 200, `${id} 저장: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.manager_only, true);
    const saved = (await db.query(`SELECT * FROM work_orders WHERE id=$1`, [id])).rows[0];
    assert.equal(saved.work_manager, '박은비');
    assert.equal(saved.bidir_state, id === 'wo-diverged' ? 'diverged' : id === 'wo-separate' ? 'separate' : 'off', '상태를 강제로 on으로 바꾸지 않는다');
    assert.ok(Number(saved.sync_version) > Number(row.sync_version));
    const ob = (await db.query(`SELECT view_scope FROM shared_sync_outbox WHERE work_order_id=$1`, [id])).rows[0];
    assert.equal(ob.view_scope, 'manager');
  }

  // 반복 요청은 현재 값과 같으면 안전한 멱등 성공, 낡은 기준의 다른 값은 거부한다.
  let row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-off'`)).rows[0];
  let out = await service.applySharedPatch({ db: { connect: async () => ({ query: db.query.bind(db), release() {} }) },
    workOrderId: row.id, mine: { work_manager: '망고' }, baseVersion: Number(row.sync_version), origin: 'rw_manager', managerOnly: true });
  assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.noop, true, '별칭은 같은 사람으로 비교');
  out = await service.applySharedPatch({ db: { connect: async () => ({ query: db.query.bind(db), release() {} }) },
    workOrderId: row.id, mine: { work_manager: '박세희' }, baseVersion: 10, origin: 'rw_manager', managerOnly: true });
  assert.equal(out.status, 409); assert.equal(out.body.code, 'manager_version_conflict');
  const concurrent = await Promise.all([
    service.applySharedPatch({ db: { connect: async () => ({ query: db.query.bind(db), release() {} }) }, workOrderId: row.id, mine: { work_manager: '박세희' }, baseVersion: Number(row.sync_version), origin: 'rw_manager', managerOnly: true }),
    service.applySharedPatch({ db: { connect: async () => ({ query: db.query.bind(db), release() {} }) }, workOrderId: row.id, mine: { work_manager: '랜덤' }, baseVersion: Number(row.sync_version), origin: 'rw_manager', managerOnly: true }),
  ]);
  assert.deepEqual(concurrent.map(x => x.status).sort(), [200, 409], `동시 저장 하나만 기준 버전을 통과한다: ${JSON.stringify(concurrent.map(x => x.body))}`);

  // 전체 payload를 보내는 구버전 인트라넷 수신은 담당자를 바꾸지 못하고, 현재 값은 좁은 대기 항목으로 돌아간다.
  await insertOrder('wo-pushback', 'off', { manager: '박세희' });
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-pushback'`)).rows[0];
  out = await service.applySharedPatch({ db: { connect: async () => ({ query: db.query.bind(db), release() {} }) },
    workOrderId: row.id, mine: { work_manager: '박세희' }, baseVersion: Number(row.sync_version), origin: 'rw_manager', managerOnly: true, forcePush: true });
  assert.equal(out.status, 200);
  const bodyOnly = push.buildPushBody(out.body.data, 'manager');
  assert.equal(bodyOnly.scope, 'manager');
  assert.deepEqual(bodyOnly.view, { work_manager: '박세희' }, '전송 payload에 다른 칸이 없다');
  assert.ok(!Object.hasOwn(bodyOnly.view, 'title'));

  // 실제 pusher도 꺼짐 상태의 manager 대기 항목을 HMAC으로 한 칸만 보낸다.
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-full-paused'`)).rows[0];
  await db.query(`INSERT INTO shared_sync_outbox(work_order_id,sync_version,view_scope) VALUES($1,$2,'full')`, [row.id, Number(row.sync_version)]);
  switchReader._resetBidirSwitchCacheForTest();
  const requests = [];
  const pushed = await push.runSharedSyncPush({
    db, env: { INTRANET_ORDER_DELETE_WEBHOOK_URL: 'https://intranet.invalid/webhook', BIDIR_RW_TO_IN_SECRET: 'test-sign', INTRANET_WEBHOOK_KEY: 'test-key' },
    fetchImpl: async (_url, options) => { requests.push(options); return new Response(JSON.stringify({ ok: true, result: 'applied' }), { status: 200 }); },
  });
  assert.ok(pushed.delivered >= 1);
  assert.ok(requests.length >= 1);
  const sent = JSON.parse(requests.find(x => JSON.parse(x.body).work_order_id === 'wo-pushback').body);
  assert.equal(sent.scope, 'manager'); assert.deepEqual(sent.view, { work_manager: '박세희' });
  const ack = (await db.query(`SELECT intranet_acked_version FROM work_orders WHERE id='wo-pushback'`)).rows[0];
  assert.equal(Number(ack.intranet_acked_version), 0, '부분 담당자 수신을 전체 공유 버전 승인으로 오인하지 않는다');
  assert.equal((await db.query(`SELECT status FROM shared_sync_outbox WHERE work_order_id='wo-full-paused'`)).rows[0].status, 'pending', '담당자 전용 전송은 전체 대기 줄을 완료 처리하지 않는다');

  // hard-off, 삭제·완료·보관·미연결은 service에서 fail-closed.
  process.env.BIDIR_HARD_OFF = '1';
  out = await service.applySharedPatch({ workOrderId: 'wo-off', mine: { work_manager: '박세희' }, baseVersion: 0, origin: 'rw_manager', managerOnly: true });
  assert.equal(out.status, 503); delete process.env.BIDIR_HARD_OFF;
  await insertOrder('wo-done', 'off', { status: 'done' });
  await insertOrder('wo-unlinked', 'off', { sourceId: '' });
  await insertOrder('wo-deleted', 'off'); await db.query(`UPDATE work_orders SET deleted_at=NOW() WHERE id='wo-deleted'`);
  await db.query(`INSERT INTO recruit_campaigns(id,source_work_order_id,archived_at) VALUES('camp-arch','wo-archived',NOW())`);
  await insertOrder('wo-archived', 'off');
  const protectedCases = [
    ['wo-done', 'manager_order_done'], ['wo-unlinked', 'manager_order_unlinked'],
    ['wo-deleted', 'order_not_found'], ['wo-archived', 'manager_campaign_archived'],
  ];
  for (const [id, code] of protectedCases) {
    row = (await db.query(`SELECT * FROM work_orders WHERE id=$1`, [id])).rows[0];
    out = await service.applySharedPatch({ db: { connect: async () => ({ query: db.query.bind(db), release() {} }) }, workOrderId: id,
      mine: { work_manager: '박은비' }, baseVersion: Number(row.sync_version), origin: 'rw_manager', managerOnly: true });
    assert.equal(out.status, id === 'wo-deleted' ? 404 : 409, `${id}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.code, code);
  }

  // 실제 관리자 편집 핸들러: 권한 없는 요청·표시 없는 요청은 막고 정상 요청은 저장 서비스로 연결한다.
  const orderRouter = require('../src/routes/order.routes');
  const pool = require('../src/db/pool');
  const dbQuery = db.query.bind(db);
  pool.query = async (sql, params) => {
    if (/CREATE TABLE IF NOT EXISTS work_orders/.test(String(sql))) return { rows: [] };
    return dbQuery(sql, params);
  };
  pool.connect = async () => ({ query: dbQuery, release() {} });
  const handler = orderRouter.handlers.orderAdminEdit;
  const response = () => ({ code: 200, body: null, status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; } });
  const call = async (role, body) => { const res = response(); await handler({ body, admin: { role, name: '테스트' } }, res, e => { throw e; }); return res; };
  const sharedLayer = (orderRouter.stack || []).find(layer => layer.route && layer.route.path === '/intake/source/:sourceReviewOrderId/shared' && layer.route.methods.get);
  assert.ok(sharedLayer, '담당자 capability 조회 경로가 있어야 한다');
  const sharedRead = async (sid, caps) => {
    const res = response();
    await sharedLayer.route.stack[0].handle({ params: { sourceReviewOrderId: sid }, query: { caps }, headers: { 'x-intake-key': 'manager-intake-test' } }, res, e => { throw e; });
    return res;
  };
  const offCaps = await sharedRead('ro_wo-off', 'manager,delivery');
  assert.equal(offCaps.code, 200); assert.deepEqual(offCaps.body.writable, ['work_manager']);
  assert.equal(offCaps.body.capabilities.manager, true); assert.equal(Object.hasOwn(offCaps.body.capabilities, 'manager_bidir'), false);
  const onCaps = await sharedRead('ro_wo-on', 'manager,delivery');
  assert.equal(onCaps.code, 200); assert.ok(onCaps.body.writable.includes('review_guide'));
  assert.ok(onCaps.body.writable.includes('work_manager'), 'ON writable keeps existing fields and adds manager');
  assert.equal(onCaps.body.capabilities.manager, true);
  const noRole = await call('staff', { id: 'wo-off', work_manager: '박세희', manager_capable: 1, manager_base_version: 10 });
  assert.equal(noRole.code, 403);
  const noMarker = await call('admin', { id: 'wo-off', work_manager: '박세희' });
  assert.equal(noMarker.code, 200, '구형 화면의 담당자 표시는 허용된 관리자 저장을 막지 않는다');
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-off'`)).rows[0];
  assert.equal(noMarker.body.data.work_manager, row.work_manager, 'capability 없는 구형 저장은 담당자를 바꾸지 않는다');
  const beforeMixed = { manager: row.work_manager, version: Number(row.sync_version), title: row.title };
  const mixedOff = await call('admin', { id: 'wo-off', work_manager: '랜덤', manager_capable: 1,
    manager_base_version: Number(row.sync_version), review_guide: 'off 혼합은 저장되면 안 됨' });
  assert.equal(mixedOff.code, 400); assert.equal(mixedOff.body.code, 'split_save');
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-off'`)).rows[0];
  assert.deepEqual([row.work_manager, Number(row.sync_version), row.title], [beforeMixed.manager, beforeMixed.version, beforeMixed.title], '꺼진 상태의 혼합 저장은 어떤 칸도 쓰지 않는다');
  const admin = await call('admin', { id: 'wo-off', work_manager: '랜덤', manager_capable: 1, manager_base_version: Number(row.sync_version) });
  assert.equal(admin.code, 200, JSON.stringify(admin.body)); assert.equal(admin.body.data.work_manager, '랜덤');

  // 연결 ON 상태에서는 담당자와 다른 공유 칸이 applySharedPatch 한 트랜잭션에서 저장된다.
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-on'`)).rows[0];
  await db.query(`INSERT INTO work_order_shared_snapshots(work_order_id,sync_version,origin,state) VALUES($1,$2,'test',$3::jsonb)`,
    [row.id, Number(row.sync_version), JSON.stringify(service.readSharedState(row))]);
  const onAdmin = await call('admin', { id: 'wo-on', work_manager: '박은비', manager_capable: 1,
    manager_base_version: Number(row.sync_version), review_guide: '한 트랜잭션 공유 변경' });
  assert.equal(onAdmin.code, 200, JSON.stringify(onAdmin.body));
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-on'`)).rows[0];
  assert.equal(row.work_manager, '박은비'); assert.equal(row.review_guide, '한 트랜잭션 공유 변경');
  assert.equal(Number(row.sync_version), Number(onAdmin.body.data.sync_version));
  assert.equal((await db.query(`SELECT view_scope FROM shared_sync_outbox WHERE work_order_id='wo-on'`)).rows[0].view_scope, 'full');
  const onFullBody = push.buildPushBody(row);
  assert.equal(onFullBody.view.work_manager, '박은비'); assert.equal(onFullBody.view.review_guide, '한 트랜잭션 공유 변경');
  const onPushRequests = [];
  await push.runSharedSyncPush({
    db, env: { INTRANET_ORDER_DELETE_WEBHOOK_URL: 'https://intranet.invalid/webhook', BIDIR_RW_TO_IN_SECRET: 'test-sign', INTRANET_WEBHOOK_KEY: 'test-key' },
    fetchImpl: async (_url, options) => { onPushRequests.push(options); return new Response(JSON.stringify({ ok: true, result: 'applied' }), { status: 200 }); },
  });
  const onSent = onPushRequests.map(x => JSON.parse(x.body)).find(body => body.work_order_id === 'wo-on');
  assert.ok(onSent, 'ON 공유 변경은 전체 payload로 전송');
  assert.equal(onSent.scope, undefined); assert.equal(onSent.view.work_manager, '박은비');
  assert.equal(onSent.view.review_guide, '한 트랜잭션 공유 변경');


  // 인트라넷 담당자 전용 저장은 공식 원본 수정 경로에서 버전 +1·내용 해시를 같은 저장으로 검사한다.
  const intakeLayer = (orderRouter.stack || []).find(layer => layer.route && layer.route.path === '/intake/source/:sourceReviewOrderId' && layer.route.methods.put);
  assert.ok(intakeLayer, '공식 원본 수정 경로가 있어야 한다');
  const intakeHandler = intakeLayer.route.stack[0].handle;
  const sourceId = 'ro_wo-diverged';
  row = (await db.query(`SELECT * FROM work_orders WHERE source_review_order_id=$1`, [sourceId])).rows[0];
  const sourceBody = {
    source_system: 'inadd_intranet', source_review_order_id: sourceId, source_revision: 1,
    idempotency_key: 'source_key_wo_diverged_1', workboard_schema_version: 1, work_series_id: '', work_round: 1,
    title: row.title, start_date: row.start_date, product_option: row.product_option, product_options_json: row.product_options_json,
    pay_amount: row.pay_amount, review_fee: row.review_fee, daily_count: row.daily_count, daily_count_text: row.daily_count_text,
    product_distribution_mode: row.product_distribution_mode, purchase_channel: row.purchase_channel, purchase_time: row.purchase_time,
    inflow_keyword: row.inflow_keyword, inflow_type: row.inflow_type, inflow_guide: row.inflow_guide,
    guide_images: [], thumbnail_url: row.thumbnail_url, required_delivery_memo: row.required_delivery_memo,
    delivery_type: row.delivery_type, courier_proxy: row.courier_proxy, review_type: row.review_type,
    review_type_mix: row.review_type_mix, recruit_count: row.recruit_count, review_guide: row.review_guide,
    special_notes: row.special_notes, product_url: row.product_url, work_sheet_url: row.work_sheet_url,
    goods_cost_type: row.goods_cost_type, manager_name: row.manager_name, work_manager: '박세희', skip_weekends: row.skip_weekends,
    holidays: [], work_kind: row.work_kind,
    bidir: { manager: 1, base_sync_version: Number(row.sync_version) },
  };
  const beforeInboundOutbox = Number((await db.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id=$1`, [row.id])).rows[0].n);
  const intakeCall = async (body, sid = sourceId) => {
    const res = response();
    await intakeHandler({ body, params: { sourceReviewOrderId: sid }, headers: { 'x-intake-key': 'manager-intake-test' } }, res, e => { throw e; });
    return res;
  };
  out = await intakeCall({ ...sourceBody, review_guide: 'off 혼합 저장 거부' });
  assert.equal(out.code, 400); assert.equal(out.body.code, 'split_save', 'OFF 상태 혼합 수신은 원본 revision 검사 전 저장을 거부');
  row = (await db.query(`SELECT * FROM work_orders WHERE source_review_order_id=$1`, [sourceId])).rows[0];
  assert.equal(Number(row.source_revision), 0); assert.equal(row.work_manager, '박은비');
  out = await intakeCall(sourceBody);
  assert.equal(out.code, 200, JSON.stringify(out.body));
  row = (await db.query(`SELECT * FROM work_orders WHERE source_review_order_id=$1`, [sourceId])).rows[0];
  assert.equal(row.work_manager, '박세희'); assert.equal(Number(row.source_revision), 1);
  assert.equal(row.intake_idempotency_key, 'source_key_wo_diverged_1');
  assert.equal(row.bidir_state, 'diverged', '인트라넷 담당자 수정도 연결 상태를 켜지 않는다');
  assert.equal(Number((await db.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id=$1`, [row.id])).rows[0].n), beforeInboundOutbox, '인트라넷발 담당자 수정은 되돌려 보내지 않는다');
  const inboundVersion = Number(row.sync_version);
  out = await intakeCall(sourceBody);
  assert.equal(out.code, 200); assert.equal(out.body.idempotent, true, '같은 원본 번호와 해시는 멱등');
  assert.equal(Number((await db.query(`SELECT sync_version FROM work_orders WHERE id=$1`, [row.id])).rows[0].sync_version), inboundVersion);
  out = await intakeCall({ ...sourceBody, idempotency_key: 'source_key_wo_diverged_1_different' });
  assert.equal(out.code, 409); assert.equal(out.body.code, 'revision_already_applied', '같은 번호·다른 내용 해시는 거부');

  // ON 상태의 신규 인트라넷 전체 저장은 담당자와 다른 공유 칸을 같은 source revision transaction에 저장한다.
  row = (await db.query(`SELECT * FROM work_orders WHERE source_review_order_id='ro_wo-on'`)).rows[0];
  const onSourceBody = { ...sourceBody, source_review_order_id: row.source_review_order_id, source_revision: 1,
    idempotency_key: 'source_key_wo_on_1', title: row.title, work_manager: '박은비', review_guide: '인트라넷 ON 전체 저장',
    bidir: { manager: 1, base_sync_version: Number(row.sync_version) } };
  out = await intakeCall(onSourceBody, row.source_review_order_id);
  assert.equal(out.code, 200, JSON.stringify(out.body));
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-on'`)).rows[0];
  assert.equal(row.work_manager, '박은비'); assert.equal(row.review_guide, '인트라넷 ON 전체 저장');
  assert.equal(Number(row.source_revision), 1);
  const onVersionBeforeLegacyRepair = Number(row.sync_version);
  out = await intakeCall({ ...onSourceBody, source_revision: 2, idempotency_key: 'source_key_wo_on_2',
    work_manager: '박세희', bidir: { base_sync_version: onVersionBeforeLegacyRepair } }, row.source_review_order_id);
  assert.equal(out.code, 200, JSON.stringify(out.body));
  row = (await db.query(`SELECT * FROM work_orders WHERE id='wo-on'`)).rows[0];
  assert.equal(row.work_manager, '박은비', '이전 인트라넷 창의 낡은 담당자 값은 보존');
  assert.equal(Number(row.source_revision), 2);
  assert.ok(Number(row.sync_version) > onVersionBeforeLegacyRepair);
  assert.equal((await db.query(`SELECT view_scope FROM shared_sync_outbox WHERE work_order_id='wo-on' AND sync_version=$1`, [Number(row.sync_version)])).rows[0].view_scope,
    'manager', '공유 변경 없이 담당자 복구만 필요하면 한 칸 전용 전송을 같은 저장 트랜잭션에 기록');

  const sharedRoute = fs.readFileSync(path.join(__dirname, '..', 'src/routes/order.routes.js'), 'utf8');
  const listRoute = fs.readFileSync(path.join(__dirname, '..', 'src/routes/trackB.routes.js'), 'utf8');
  const trackService = fs.readFileSync(path.join(__dirname, '..', 'src/services/trackB.service.js'), 'utf8');
  assert.match(sharedRoute, /caps\.has\('manager'\)[\s\S]*managerCapable[\s\S]*\['work_manager'\]/);
  assert.match(listRoute, /manager_edit_capable[\s\S]*manager_base_version/);
  assert.match(trackService, /managerEditAllowed[\s\S]*_cond\.managerEdit = \{ capable: true, workOrderId: wo\[0\]\.id, syncVersion: Number\(wo\[0\]\.syncVersion \|\| 0\) \}/);
  assert.match(trackService, /WHERE deleted_at IS NULL AND linked_tab_sheet_id=\$1 AND linked_tab_name=\$2\s+ORDER BY created_at DESC LIMIT 1/,
    '조건 카드 담당자는 최신 직접 연결 오더 기준이며 오래된 수동 링크를 쓰지 않는다');
  assert.match(listRoute, /router\.get\('\/work-orders',[\s\S]*manager_edit_capable/,
    '원시 작업오더 목록도 편집 가능 여부를 반환한다');
  await db.close();
  console.log('managerBidirBackend: local fake-storage route/service/pusher cases passed');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
