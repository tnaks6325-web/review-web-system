'use strict';

// 결정 395 — 인트라넷 작업담당 「랜덤」 자동 배정(진행 중 작업이 적은 쪽 · 같으면 번갈아) + 보관 공고 작업의 담당자 변경 허용.
// 실제 접수·원본 수정·관리자 capability 핸들러, 실제 공유 저장(applySharedPatch)·전송기(runSharedSyncPush)를
// 메모리 PGlite 에서 돌린다. 운영 DB·외부 주소에는 연결하지 않는다(전송은 가짜 fetch).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

process.env.JWT_SECRET = 'auto-manager-test-secret';
process.env.ORDER_INTAKE_KEY = 'auto-manager-intake-test';
delete process.env.BIDIR_HARD_OFF;

const PUSH_ENV = { INTRANET_ORDER_DELETE_WEBHOOK_URL: 'https://intranet.invalid/webhook', BIDIR_RW_TO_IN_SECRET: 'test-sign', INTRANET_WEBHOOK_KEY: 'test-key' };

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE work_orders (
      id TEXT PRIMARY KEY, source_review_order_id TEXT NOT NULL DEFAULT '', work_manager TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'reviewing', deleted_at TIMESTAMPTZ, linked_campaign_id TEXT NOT NULL DEFAULT '',
      sync_version BIGINT NOT NULL DEFAULT 0, intranet_acked_version BIGINT NOT NULL DEFAULT 0,
      source_revision INTEGER NOT NULL DEFAULT 0, intake_idempotency_key TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by TEXT NOT NULL DEFAULT '',
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
      manager_name TEXT NOT NULL DEFAULT '', skip_weekends BOOLEAN, holidays TEXT, work_kind TEXT NOT NULL DEFAULT 'review', memo_log JSONB NOT NULL DEFAULT '[]',
      intranet_advertiser_name TEXT NOT NULL DEFAULT '', intranet_advertiser_contact TEXT NOT NULL DEFAULT '',
      intranet_advertiser_business_number TEXT NOT NULL DEFAULT '', sales_id TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '',
      contract_number TEXT NOT NULL DEFAULT '', intranet_advertiser_id TEXT NOT NULL DEFAULT '', purchase_channel_custom BOOLEAN NOT NULL DEFAULT FALSE,
      linked_tab_sheet_id TEXT NOT NULL DEFAULT '', linked_tab_name TEXT NOT NULL DEFAULT '', linked_tab_gid TEXT NOT NULL DEFAULT '',
      bidir_state TEXT NOT NULL DEFAULT 'off'
    );
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', source_work_order_id TEXT NOT NULL DEFAULT '', linked_sheet_id TEXT NOT NULL DEFAULT '', linked_tab_name TEXT NOT NULL DEFAULT '', archived_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE work_order_shared_snapshots (
      work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL, origin TEXT NOT NULL, op_id TEXT NOT NULL DEFAULT '',
      state JSONB NOT NULL, actor TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (work_order_id, sync_version)
    );
    CREATE TABLE shared_sync_outbox (
      id BIGSERIAL PRIMARY KEY, work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (work_order_id, sync_version)
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE trackb_tab_finished (sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL, tab_gid TEXT NOT NULL DEFAULT '',
      finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_by TEXT NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ);
    CREATE TABLE trackb_work_order_links (work_order_id TEXT NOT NULL, sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations/206_shared_sync_outbox_scope.sql'), 'utf8'));
  await db.query(`INSERT INTO app_settings(key,value) VALUES ('bidir_sync', $1)`, [JSON.stringify({ in2rw: 'apply', push: 'on' })]);

  // ── 실제 pool 자리에 PGlite 를 끼운다. 트랜잭션은 BEGIN~COMMIT/ROLLBACK 동안 한 줄로 세운다(한 세션 PGlite 라
  //    두 트랜잭션이 섞이지 않게). 트랜잭션 밖 조회는 기다리지 않는다(종전 하네스와 같다).
  const pool = require('../src/db/pool');
  const dbQuery = db.query.bind(db);
  let txTail = Promise.resolve();
  const makeClient = () => {
    let release = null;
    return {
      async query(sql, params) {
        const s = String(sql).trim().toUpperCase();
        if (s === 'BEGIN') {
          let done; const gate = new Promise(r => { done = r; });
          const prev = txTail; txTail = prev.then(() => gate);
          await prev; release = done;
        }
        try { return await dbQuery(sql, params); }
        finally {
          if ((s === 'COMMIT' || s === 'ROLLBACK') && release) { const r = release; release = null; r(); }
        }
      },
      release() { if (release) { const r = release; release = null; r(); } },
    };
  };
  pool.query = async (sql, params) => {
    if (/CREATE TABLE|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX/.test(String(sql))) return { rows: [] };
    return dbQuery(sql, params);
  };
  pool.connect = async () => makeClient();

  const switchReader = require('../src/utils/bidirSwitch');
  switchReader._resetBidirSwitchCacheForTest();
  const service = require('../src/services/sharedPatch.service');
  const push = require('../src/services/sharedSyncPush.service');
  // RED 단계에서도 모든 갈래의 실패를 한 번에 보이도록 서비스가 없으면 null(그 갈래만 실패로 기록).
  let auto = null;
  try { auto = require('../src/services/autoWorkManager.service'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  const failures = [];
  const section = async (name, fn) => {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (e) { failures.push(name); console.error(`✗ ${name}\n  ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n  ') : e}`); }
  };
  const need = () => { if (!auto) throw new Error('autoWorkManager.service 없음(아직 구현 전)'); return auto; };
  const orderRouter = require('../src/routes/order.routes');
  const routeOf = (p, m) => (orderRouter.stack || []).find(l => l.route && l.route.path === p && l.route.methods[m]).route.stack.at(-1).handle;
  const intakeHandler = routeOf('/intake', 'post');
  const sourceHandler = routeOf('/intake/source/:sourceReviewOrderId', 'put');
  const sharedHandler = routeOf('/intake/source/:sourceReviewOrderId/shared', 'get');
  const response = () => ({ code: 200, body: null, status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; } });
  const run = async (handler, req) => { const res = response(); await handler({ headers: { 'x-intake-key': 'auto-manager-intake-test' }, params: {}, query: {}, ...req }, res, e => { throw e; }); return res; };

  let res, saved, ob, sent, load;
  let seq = 0;
  const seed = async (manager, extra = {}) => {
    const id = extra.id || `seed-${++seq}`;
    await db.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,status,linked_campaign_id,sync_version,title,linked_tab_sheet_id,linked_tab_name,linked_tab_gid)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, extra.sourceId === undefined ? `ro_${id}` : extra.sourceId, manager,
      extra.status || 'published', extra.campaign || '', extra.version || 10, `가짜 ${id}`, extra.sheet || 'fake-sheet', extra.tab || `탭 ${id}`, extra.gid || '']);
    if (extra.deleted) await db.query('UPDATE work_orders SET deleted_at=NOW() WHERE id=$1', [id]);
    return id;
  };
  let intakeSeq = 0;
  const intakeBody = (manager, extra = {}) => {
    const n = ++intakeSeq;
    const b = { title: `가짜 접수 ${n}`, recruit_count: 3, daily_count: 1, requester_name: '가짜 AE',
      source_review_order_id: `ro_intake_${n}`, source_revision: 1, idempotency_key: `intake_key_${n}`, workboard_schema_version: 1, ...extra };
    if (manager !== undefined) b.work_manager = manager;
    return b;
  };
  const row = async id => (await db.query('SELECT * FROM work_orders WHERE id=$1', [id])).rows[0];
  const outboxOf = async id => (await db.query('SELECT * FROM shared_sync_outbox WHERE work_order_id=$1 ORDER BY id', [id])).rows;
  const autoSnapshots = async id => (await db.query(`SELECT * FROM work_order_shared_snapshots WHERE work_order_id=$1 AND actor='자동배정'`, [id])).rows;
  const lastSetting = async () => ((await db.query(`SELECT value FROM app_settings WHERE key='auto_work_manager_last'`)).rows[0] || {}).value || '';
  const drain = async () => { if (auto) await auto._drainForTest(); };
  const intake = async body => { const res = await run(intakeHandler, { body }); await drain(); return res; };

  // ── 진행 중 부하: 만두(박세희) 2 · 망고(박은비) 1. 진행이 아닌 것(완료·반려·삭제·보관 공고 정·역방향·🏁 마감)은 세지 않는다.
  await seed('박세희'); await seed('박세희'); await seed('박은비');
  for (let i = 0; i < 3; i++) await seed('박은비', { status: 'done' });
  await seed('박은비', { status: 'rejected' });
  await seed('박은비', { deleted: true });
  const archFwd = await seed('박은비', { campaign: 'camp-arch-fwd' });
  await db.query(`INSERT INTO recruit_campaigns(id,archived_at) VALUES('camp-arch-fwd',NOW())`);
  const archRev = await seed('박은비');
  await db.query(`INSERT INTO recruit_campaigns(id,source_work_order_id,archived_at) VALUES('camp-arch-rev',$1,NOW())`, [archRev]);
  await seed('박은비', { sheet: 'fin-sheet', tab: '마감 탭' });
  await db.query(`INSERT INTO trackb_tab_finished(sheet_id,tab_name) VALUES('fin-sheet','마감 탭')`);
  await seed('랜덤'); await seed(''); await seed('기타');   // 미지정·기타는 어느 쪽 부하도 아니다
  await section('1) intake 랜덤 → lower-load side + manager outbox + push', async () => {
  const load0 = await need().countLoad(pool);
  assert.deepEqual(load0, { '박세희': 2, '박은비': 1 }, '진행 중 부하는 완료·반려·삭제·보관 공고·마감 작업을 뺀다');

  // ── 1) 새 접수 「랜덤」 → 적은 쪽(망고=박은비)으로 자동 배정 + 인트라넷 전송 대기(담당자 범위) · 접수 응답은 종전 그대로
  res = await intake(intakeBody('랜덤'));
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.work_manager, '랜덤', '접수 응답 자체는 바뀌지 않는다(배정은 커밋 뒤)');
  const first = res.body.data.id;
  saved = await row(first);
  assert.equal(saved.work_manager, '박은비', '진행 중 작업이 적은 망고(박은비)로 자동 배정');
  assert.equal(Number(saved.source_revision), 1, '원본 번호는 그대로(정확히 +1 규칙 불변)');
  assert.ok(Number(saved.sync_version) > 0);
  ob = await outboxOf(first);
  assert.equal(ob.length, 1); assert.equal(ob[0].view_scope, 'manager'); assert.equal(Number(ob[0].sync_version), Number(saved.sync_version));
  assert.equal((await autoSnapshots(first)).length, 1, '공유 저장 스냅숏에 자동배정으로 남는다');
  assert.equal(await lastSetting(), '박은비');
  // 실제 전송기가 담당자 한 칸만 인트라넷 이름으로 보낸다
  switchReader._resetBidirSwitchCacheForTest();
  sent = [];
  await push.runSharedSyncPush({ db, env: PUSH_ENV, fetchImpl: async (_u, o) => { sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ok: true, result: 'applied' }), { status: 200 }); } });
  const firstSent = sent.find(b => b.work_order_id === first);
  assert.ok(firstSent, '자동 배정이 인트라넷으로 전송된다');
  assert.equal(firstSent.scope, 'manager'); assert.deepEqual(firstSent.view, { work_manager: '박은비' });
  // 같은 접수의 재시도(멱등)는 다시 배정하지 않는다
  const replay = await run(intakeHandler, { body: { ...intakeBody('랜덤'), source_review_order_id: saved.source_review_order_id, idempotency_key: saved.intake_idempotency_key, title: saved.title } });
  await drain();
  assert.equal(replay.code, 200); assert.equal(replay.body.idempotent, true);
  assert.equal((await autoSnapshots(first)).length, 1, '멱등 재시도는 배정을 다시 하지 않는다');
  });

  await section('2) tie alternation', async () => {
  // ── 2) 같으면 번갈아: 2:2 (마지막 자동 배정 = 박은비) → 박세희 · 3:2 → 박은비 · 3:3 (마지막 박은비) → 박세희
  const picks = [];
  for (let i = 0; i < 3; i++) {
    res = await intake(intakeBody('랜덤배정'));
    assert.equal(res.code, 200, JSON.stringify(res.body));
    picks.push((await row(res.body.data.id)).work_manager);
  }
  assert.deepEqual(picks, ['박세희', '박은비', '박세희'], '같으면 마지막 자동 배정의 반대쪽, 아니면 적은 쪽');
  assert.equal(need().pickSide({ '박세희': 1, '박은비': 1 }, ''), '박세희', '기록 없는 동률 = 만두부터(결정적)');
  assert.equal(need().pickSide({ '박세희': 1, '박은비': 1 }, '박세희'), '박은비');
  assert.equal(need().pickSide({ '박세희': 0, '박은비': 5 }, '박세희'), '박세희', '적은 쪽이 번갈아보다 먼저');
  });

  await section('3) concurrent intakes split', async () => {
  // ── 3) 경합: B 가 미리 고른 뒤 잠금 전에 A 가 끝까지 저장 → B 는 잠금 안에서 다시 세어 반대쪽으로(같은 쪽 둘 금지)
  load = await need().countLoad(pool);
  assert.equal(load['박세희'], load['박은비'] + 1, `지금 부하 ${JSON.stringify(load)}`);
  await seed('박은비');   // 동률로 맞춘다
  const idA = await seed('랜덤'), idB = await seed('랜덤');
  let injected = false;
  const bTx = [];
  const racingDb = { query: (s, p) => pool.query(s, p), connect: async () => {
    const c = makeClient();
    return { release: () => c.release(), query: async (sql, params) => {
      bTx.push(String(sql));
      if (!injected && String(sql).trim().toUpperCase() === 'BEGIN') {
        injected = true;
        const outA = await need().autoAssignUndecided({ workOrderId: idA, db: pool });
        assert.equal(outA.applied, true, JSON.stringify(outA));
      }
      return c.query(sql, params);
    } };
  } };
  const outB = await need().autoAssignUndecided({ workOrderId: idB, db: racingDb });
  assert.equal(injected, true, '실제 끼어들기가 일어났다');
  assert.equal(outB.applied, true, JSON.stringify(outB));
  const [a, b] = [await row(idA), await row(idB)];
  assert.notEqual(a.work_manager, b.work_manager, `동시 배정이 같은 쪽으로 몰리면 안 된다: ${a.work_manager}/${b.work_manager}`);
  // 다시 세기는 자동 배정 전용 잠금을 잡은 **뒤**에 한다(실제 PostgreSQL 다중 세션에서 둘이 동시에 세지 않게).
  const lockAt = bTx.findIndex(q => /pg_advisory_xact_lock\(hashtext\('auto_work_manager'\)\)/.test(q));
  const recountAt = bTx.findIndex((q, i) => i > 0 && /FROM work_orders w\s+WHERE w\.deleted_at IS NULL/.test(q));
  const beginAt = bTx.findIndex(q => q.trim().toUpperCase() === 'BEGIN');
  assert.ok(beginAt >= 0 && lockAt > beginAt, '자동 배정 잠금은 트랜잭션 안에서 잡는다');
  assert.ok(recountAt > lockAt, `잠금 뒤에 다시 센다(잠금 ${lockAt} · 다시 세기 ${recountAt})`);
  assert.ok(bTx.filter(q => q.trim().toUpperCase() === 'BEGIN').length >= 2, '앞 배정을 보고 물러난 뒤 다시 시도했다(다시 고르기 경로 실제 실행)');
  // 동시에 들어온 두 접수(실제 핸들러 · 직렬화된 트랜잭션)도 한쪽씩
  load = await need().countLoad(pool);
  assert.equal(load['박세희'], load['박은비'], `동률 전제 ${JSON.stringify(load)}`);
  const both = await Promise.all([run(intakeHandler, { body: intakeBody('랜덤') }), run(intakeHandler, { body: intakeBody('랜덤') })]);
  await drain();
  const bothManagers = [];
  for (const r of both) { assert.equal(r.code, 200); bothManagers.push((await row(r.body.data.id)).work_manager); }
  assert.deepEqual(bothManagers.slice().sort(), ['박세희', '박은비'], `동시 접수 둘은 한쪽씩: ${bothManagers}`);
  });

  await section('4) non-undecided intake untouched', async () => {
  // ── 4) 배정하지 않는 값: 박세희·기타·빈 값·작업담당 칸 없음·사람 이름 「이미정」 → 그대로 · 전송 0
  for (const manager of ['박세희', '기타', '', undefined, '이미정']) {
    res = await intake(intakeBody(manager));
    assert.equal(res.code, 200, JSON.stringify(res.body));
    const r = await row(res.body.data.id);
    assert.equal(r.work_manager, manager || '', `${manager} 는 그대로`);
    assert.equal((await outboxOf(r.id)).length, 0, `${manager}: 전송 대기 0`);
    assert.equal((await autoSnapshots(r.id)).length, 0);
  }
  });

  await section('5) auto-assign failure keeps intake 200', async () => {
  need();
  // ── 5) 자동 배정 실패는 접수를 실패시키지 않는다(fail-soft) — 비상 정지 · 마감 조회 실패 · 원본 없는 옛 접수
  process.env.BIDIR_HARD_OFF = '1';
  res = await intake(intakeBody('랜덤'));
  delete process.env.BIDIR_HARD_OFF;
  assert.equal(res.code, 200);
  assert.equal((await row(res.body.data.id)).work_manager, '랜덤', '비상 정지면 종전처럼 미지정으로 남는다');
  assert.equal((await outboxOf(res.body.data.id)).length, 0);
  await db.exec('ALTER TABLE trackb_tab_finished RENAME TO trackb_tab_finished_hidden');
  res = await intake(intakeBody('랜덤'));
  await db.exec('ALTER TABLE trackb_tab_finished_hidden RENAME TO trackb_tab_finished');
  assert.equal(res.code, 200);
  assert.equal((await row(res.body.data.id)).work_manager, '랜덤', '진행 부하를 모르면 추측하지 않고 미지정으로 둔다');
  res = await intake({ title: '원본 없는 옛 접수', work_manager: '랜덤', recruit_count: 1 });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal((await row(res.body.data.id)).work_manager, '랜덤', '인트라넷 원본이 없는 오더는 공유 저장 대상이 아니다');
  });

  await section('6) source revision → 랜덤 auto-assigns, no backfill', async () => {
  need();
  // ── 6) 원본 수정이 작업담당을 랜덤으로 바꾸면 자동 배정 · 원래 랜덤/빈 값인 오더의 다른 수정은 배정하지 않는다(소급 금지)
  const sourceBodyOf = (r, extra) => ({
    source_system: 'inadd_intranet', source_review_order_id: r.source_review_order_id, source_revision: 1,
    idempotency_key: `rev_${r.id}_${extra.idempotency_key || 1}`, workboard_schema_version: 1, work_series_id: '', work_round: 1,
    title: r.title, start_date: r.start_date, product_option: r.product_option, product_options_json: r.product_options_json,
    pay_amount: r.pay_amount, review_fee: r.review_fee, daily_count: r.daily_count, daily_count_text: r.daily_count_text,
    product_distribution_mode: r.product_distribution_mode, purchase_channel: r.purchase_channel, purchase_time: r.purchase_time,
    inflow_keyword: r.inflow_keyword, inflow_type: r.inflow_type, inflow_guide: r.inflow_guide, guide_images: [],
    thumbnail_url: r.thumbnail_url, required_delivery_memo: r.required_delivery_memo, delivery_type: r.delivery_type,
    courier_proxy: r.courier_proxy, review_type: r.review_type, review_type_mix: r.review_type_mix, recruit_count: r.recruit_count,
    review_guide: r.review_guide, special_notes: r.special_notes, product_url: r.product_url, work_sheet_url: r.work_sheet_url,
    goods_cost_type: r.goods_cost_type, manager_name: r.manager_name, skip_weekends: r.skip_weekends, holidays: [], work_kind: r.work_kind,
    bidir: { manager: 1, base_sync_version: Number(r.sync_version) }, ...extra,
  });
  const revId = await seed('박세희', { status: 'reviewing' });
  let before = await row(revId);
  res = await run(sourceHandler, { params: { sourceReviewOrderId: before.source_review_order_id }, body: sourceBodyOf(before, { work_manager: '랜덤' }) });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.work_manager, '랜덤', '원본 수정 응답은 종전 그대로(인트라넷 확인 버전 계약 불변)');
  assert.ok(res.body.manager_ack_version > 0);
  await drain();
  saved = await row(revId);
  assert.ok(['박세희', '박은비'].includes(saved.work_manager), `원본 수정으로 랜덤이 되면 자동 배정: ${saved.work_manager}`);
  assert.equal(Number(saved.source_revision), 1, '자동 배정은 원본 번호를 올리지 않는다');
  assert.ok(Number(saved.sync_version) > Number(res.body.manager_ack_version), '자동 배정은 새 버전으로 인트라넷에 되돌려 보낸다');
  ob = await outboxOf(revId);
  assert.ok(ob.some(o => o.view_scope === 'manager' && Number(o.sync_version) === Number(saved.sync_version)));
  for (const prior of ['랜덤', '']) {
    const id = await seed(prior, { status: 'reviewing' });
    before = await row(id);
    res = await run(sourceHandler, { params: { sourceReviewOrderId: before.source_review_order_id }, body: sourceBodyOf(before, { work_manager: '랜덤' }) });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    await drain();
    assert.equal((await autoSnapshots(id)).length, 0, `이미 ${prior || '빈 값'}이던 오더는 소급 배정하지 않는다`);
  }
  // PR #1859 리뷰(P2): 원본 수정이 사람 이름 「이미정」을 보내면 저장 정규화가 랜덤으로 접어도 **요청 원문**이 정확한 랜덤이 아니므로 배정하지 않는다.
  {
    const id = await seed('박세희', { status: 'reviewing' });
    before = await row(id);
    res = await run(sourceHandler, { params: { sourceReviewOrderId: before.source_review_order_id }, body: sourceBodyOf(before, { work_manager: '이미정' }) });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    await drain();
    assert.equal((await autoSnapshots(id)).length, 0, '원본 수정의 「이미정」(사람 이름)은 자동 배정하지 않는다');
  }
  });

  await section('7) archived campaign manager change allowed, done blocked', async () => {
  // ── 7) 보관 공고 작업(완료 아님)은 담당자를 바꿀 수 있다 · 완료는 그대로 막는다
  for (const kind of ['fwd', 'rev']) {
    const id = await seed('박세희', { status: 'published', campaign: kind === 'fwd' ? `camp-a-${kind}` : '' });
    await db.query(`INSERT INTO recruit_campaigns(id,source_work_order_id,archived_at) VALUES($1,$2,NOW())`, [`camp-a-${kind}`, kind === 'rev' ? id : '']);
    const r0 = await row(id);
    const caps = await run(sharedHandler, { params: { sourceReviewOrderId: r0.source_review_order_id }, query: { caps: 'manager' } });
    assert.equal(caps.code, 200);
    assert.deepEqual(caps.body.writable, ['work_manager'], `${kind}: 보관 공고 작업도 인트라넷 작업담당 버튼이 열린다`);
    assert.equal(caps.body.manager_edit_capable, true);
    const out = await service.applySharedPatch({ workOrderId: id, mine: { work_manager: '박은비' }, baseVersion: Number(r0.sync_version), origin: 'rw_manager', managerOnly: true, actor: '테스트' });
    assert.equal(out.status, 200, `${kind}: ${JSON.stringify(out.body)}`);
    sent = [];
    await push.runSharedSyncPush({ db, env: PUSH_ENV, fetchImpl: async (_u, o) => { sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ok: true, result: 'applied' }), { status: 200 }); } });
    assert.ok(sent.some(m => m.work_order_id === id && m.view.work_manager === '박은비'), `${kind}: 보관 공고 작업의 담당자 변경도 인트라넷에 전달`);
    assert.equal((await outboxOf(id))[0].status, 'delivered');
  }
  const doneId = await seed('박세희', { status: 'done' });
  const doneRow = await row(doneId);
  const doneCaps = await run(sharedHandler, { params: { sourceReviewOrderId: doneRow.source_review_order_id }, query: { caps: 'manager' } });
  assert.equal(doneCaps.body.manager_edit_capable, false, '완료 작업은 여전히 닫힘');
  const doneOut = await service.applySharedPatch({ workOrderId: doneId, mine: { work_manager: '박은비' }, baseVersion: Number(doneRow.sync_version), origin: 'rw_manager', managerOnly: true });
  assert.equal(doneOut.status, 409); assert.equal(doneOut.body.code, 'manager_order_done');
  // 작업 목록 두 곳(작업보드 연결 후보·작업오더 목록)의 편집 가능 표시도 같은 기준(실제 SQL)
  const trackB = require('../src/services/trackB.service');
  const list = await trackB.listWorkOrders({ limit: 300 });
  const archivedListed = list.find(x => x.id === archFwd);
  assert.equal(archivedListed.manager_edit_capable, true, '보관 공고 작업도 편집 가능 표시');
  assert.equal(list.find(x => x.id === doneId).manager_edit_capable, false);
  const trackBRouter = require('../src/routes/trackB.routes');
  const listLayer = trackBRouter.stack.find(l => l.route && l.route.path === '/work-orders/list' && l.route.methods.get);
  const listRes = response();
  await listLayer.route.stack.at(-1).handle({ query: {}, admin: { role: 'master', name: '테스트' } }, listRes, e => { throw e; });
  assert.equal(listRes.code, 200, JSON.stringify(listRes.body));
  assert.equal(listRes.body.data.find(x => x.id === archRev).manager_edit_capable, true, '역방향 보관 공고 작업도 열림');
  assert.equal(listRes.body.data.find(x => x.id === doneId).manager_edit_capable, false);
  const trackSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/trackB.service.js'), 'utf8');
  const quick = trackSrc.slice(trackSrc.indexOf('담당자 빠른 배정은 작업 홈'), trackSrc.indexOf('총 모집완료 표기는'));
  assert.ok(quick.length > 0 && !/archived_at/.test(quick), '작업보드 빠른 배정 판정에 보관 공고 잠금이 남지 않는다');
  });

  await db.close();
  if (failures.length) throw new Error(`실패 ${failures.length}갈래: ${failures.join(' / ')}`);
  console.log('autoWorkManager: all cases passed');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
