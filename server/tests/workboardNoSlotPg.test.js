'use strict';
/* 결정 324 — 작업표 빈 줄이 없어 작업보드 반영(workboard_apply)이 막힌 주문.
 * 진짜 SQL(pglite)로 고정한다:
 *  A. 큐 실행부 — writeOrderToWorktable 의 no_open_slot 은 정해진 「보류」 문장으로 failed 가 된다(주문 sheet_error 도 같은 문장).
 *  B. 매시 retryAllFailed — 빈 줄 없음 failed 행(새 문장·결정 전 문장)은 되살리지 않는다(행·attempts·문장 그대로, 지우지 않음).
 *     다른 실패 사유·문장 없는 실패는 종전대로 되살린다. 그 작업표에 빈 줄이 생기면 그 행만 되살린다(주문 queued).
 *  C. 홈 「오늘 확인할 것」 — 막힌 주문마다 한 항목(사람 문장 · 이름+연락처 끝 4자리만) · 은행 목록·담당자 질문에 섞이지 않음 ·
 *     [다시 넣기]는 빈 줄 없으면 거부(아무것도 안 바뀜)·있으면 기존 retryItem 으로 pending · [확인함]은 닫고 다시 열지 않음 ·
 *     작업표에 들어가면/취소되면 저절로 닫힘.
 *  D. 실제 Express 라우트 — 로그인·권한(admin/master + 편집 명단) · 홈 전용 목록 · 답.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const SRC = path.join(__dirname, '../src');
const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(SRC, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
};

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE sync_queue(id serial PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, status text DEFAULT 'pending',
      attempts int DEFAULT 0, max_retry int DEFAULT 3, error_msg text, created_at timestamptz DEFAULT now(), processed_at timestamptz);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, deleted_at timestamptz, updated_at timestamptz, mirror_status text,
      sheet_error text, sheet_id text, tab_name text, tab_gid text, gid text, orderer text, recipient text, user_id text,
      phone text, address text, bank text, account text, depositor text, price text, order_num text, memo text, date_str text,
      selected_opt_key text, selected_product text, blog_url text, workboard_id uuid, sheet_row int,
      submitted_at timestamptz DEFAULT now());
    CREATE TABLE tab_configs(sheet_id text, tab_name text, tab_gid text, display_name text DEFAULT '', manager text DEFAULT '',
      sheetless boolean DEFAULT true, workboard_id uuid);
    CREATE TABLE campaign_participants(id serial, sheet_id text, tab_name text, seq int, deleted_at timestamptz,
      active boolean DEFAULT true, order_submission_id uuid, reviewer_name text, recipient_name text, phone8 text, workboard_id uuid);
    CREATE TABLE workboard_consolidation_targets(sheet_id text, tab_name text, workboard_id uuid, rollout_state text);
    CREATE TABLE workboards(id uuid PRIMARY KEY, state text);
    CREATE TABLE app_settings(key text PRIMARY KEY, value text);
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/205_ops_checks.sql'), 'utf8'));

  const q = async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; };
  let tail = Promise.resolve();
  const pool = {
    query: q,
    connect: async () => { let release; const next = new Promise(r => { release = r; }); const prev = tail; tail = next; await prev;
      return { query: q, release }; },
  };
  stub('db/pool.js', pool);
  const kicks = [];
  stub('jobs/queuePump.js', { kickQueuePump: () => kicks.push(1) });
  stub('services/workboardConsolidation.service.js', { getControl: async () => ({ mode: 'enabled' }) });
  let writeOut = { ok: false, reason: 'no_open_slot' };
  stub('services/sheetlessOrder.service.js', { writeOrderToWorktable: async () => writeOut });
  stub('services/orderLedger.service.js', {
    _osRowToOrderData: r => r, markOrderWritten: async () => {}, markOrderQueued: async () => {},
  });

  const { NO_SLOT_QUEUE_ERROR, LEGACY_NO_SLOT_QUEUE_ERROR } = require('../src/utils/workboardNoSlot');
  const sq = require('../src/services/syncQueue.service');
  const ops = require('../src/services/opsCheck.service');
  ops.__setPoolForTest(pool);
  const slot = require('../src/services/workboardSlotOpsCheck.service');
  const manager = require('../src/services/managerOpsCheck.service');

  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

  const WB = '00000000-0000-4000-8000-0000000000aa';
  const FULL = { sheetId: 'wt_full', tabName: '9/7_비타민_200건', gid: '838' };
  const OTHER = { sheetId: 'wt_other', tabName: '다른작업', gid: '999' };
  await db.query(`INSERT INTO workboards VALUES ($1,'active')`, [WB]);
  for (const tab of [FULL, OTHER]) {
    await db.query(`INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,display_name,workboard_id) VALUES ($1,$2,$3,$4,$5)`,
      [tab.sheetId, tab.tabName, tab.gid, tab.tabName + ' 표시', WB]);
    await db.query(`INSERT INTO workboard_consolidation_targets VALUES ($1,$2,$3,'enabled')`, [tab.sheetId, tab.tabName, WB]);
    // 꽉 찬 작업표(채워진 줄 2개)
    for (let s = 1; s <= 2; s++) {
      await db.query(`INSERT INTO campaign_participants(sheet_id,tab_name,seq,order_submission_id,reviewer_name,phone8)
        VALUES ($1,$2,$3,gen_random_uuid(),'채움','1111222${s}')`, [tab.sheetId, tab.tabName, s]);
    }
  }
  let n = 0;
  const newOrder = async (tab, extra = {}) => {
    n++;
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await db.query(`INSERT INTO order_submissions(id, mirror_status, sheet_id, tab_name, tab_gid, gid, orderer, phone, address, account, submitted_at)
      VALUES ($1,'queued',$2,$3,$4,$4,$5,'010-9750-7564','서울시 가짜로 1','111-222-333333','2026-10-26T02:48:47Z')`,
      [id, tab.sheetId, tab.tabName, tab.gid, extra.orderer || '가짜리뷰어']);
    return id;
  };
  const enqueueFor = async (tab, osId, status = 'pending', errorMsg = null, attempts = 0) => {
    const { rows } = await db.query(`INSERT INTO sync_queue(type,payload,status,attempts,error_msg)
      VALUES ('workboard_apply',$1,$2,$3,$4) RETURNING id`,
      [JSON.stringify({ sheetId: tab.sheetId, tabName: tab.tabName, gid: tab.gid, orderSubmissionId: osId }), status, attempts, errorMsg]);
    return rows[0].id;
  };
  const row = async id => (await db.query(`SELECT * FROM sync_queue WHERE id=$1`, [id])).rows[0];
  const order = async id => (await db.query(`SELECT * FROM order_submissions WHERE id=$1`, [id])).rows[0];

  // ═══ A. 큐 실행부 ═══
  const osA = await newOrder(FULL);
  const qA = await enqueueFor(FULL, osA);
  await t('A1 빈 줄 없음 → 3회 뒤 failed · 정해진 보류 문장(주문 sheet_error 도 같음)', async () => {
    for (let k = 0; k < 3; k++) await sq.processQueue(10, { interItemDelayMs: 0 });
    const r = await row(qA);
    assert.equal(r.status, 'failed');
    assert.equal(r.error_msg, NO_SLOT_QUEUE_ERROR);
    const o = await order(osA);
    assert.equal(o.mirror_status, 'failed');
    assert.equal(o.sheet_error, NO_SLOT_QUEUE_ERROR);
  });

  // ═══ B. 매시 retryAllFailed ═══
  const osLegacy = await newOrder(OTHER);
  const qLegacy = await enqueueFor(OTHER, osLegacy, 'failed', LEGACY_NO_SLOT_QUEUE_ERROR, 3);
  const osOtherFail = await newOrder(OTHER);
  const qOtherFail = await enqueueFor(OTHER, osOtherFail, 'failed', '작업보드 반영 실패: workboard row verification failed', 3);
  const qNullMsg = await enqueueFor(OTHER, await newOrder(OTHER), 'failed', null, 3);
  await t('B1 빈 줄 없음 failed(새 문장·결정 전 문장)는 되살리지 않는다 · 다른 실패는 종전대로 되살린다', async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM sync_queue`)).rows[0].n;
    const r = await sq.retryAllFailed();
    for (const id of [qA, qLegacy]) {
      const x = await row(id);
      assert.equal(x.status, 'failed', 'no-slot row stays failed: ' + id);
      assert.equal(x.attempts, 3);
      assert.ok([NO_SLOT_QUEUE_ERROR, LEGACY_NO_SLOT_QUEUE_ERROR].includes(x.error_msg));
    }
    for (const id of [qOtherFail, qNullMsg]) {
      const x = await row(id);
      assert.equal(x.status, 'pending', 'other failure revived: ' + id);
      assert.equal(x.attempts, 0);
    }
    assert.equal(r.retried, 2);
    assert.equal(r.revivedNoSlot, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM sync_queue`)).rows[0].n, before, '행을 지우지 않는다');
  });
  await t('B2 시간이 지나도(다시 돌려도) 끝없는 실패가 없다 — 워커가 빈 줄 없음 행을 다시 집지 않는다', async () => {
    await sq.retryAllFailed();
    const x = await row(qA);
    assert.equal(x.status, 'failed');
    assert.equal(x.attempts, 3);
  });

  // ═══ C. 홈 「오늘 확인할 것」 ═══
  await t('C1 막힌 주문마다 한 항목 — 사람 문장 · 이름 + 연락처 끝 4자리만 · 다른 실패는 항목 아님', async () => {
    await slot.refresh(pool);
    await slot.refresh(pool);   // 두 번 불러도 한 항목
    const { items } = await slot.list({ db: pool, allowed: true });
    const ids = items.map(i => i.facts.orderSubmissionId).sort();
    assert.deepEqual(ids, [osA, osLegacy].sort());
    const a = items.find(i => i.facts.orderSubmissionId === osA);
    assert.equal(a.kind, 'workboard_no_slot');
    assert.equal(a.status, 'open');
    assert.equal(a.facts.title, FULL.tabName + ' 표시');
    assert.equal(a.facts.phone4, '7564');
    assert.equal(a.facts.rowCount, 2);
    assert.equal(a.queueState, 'blocked');
    const text = a.lines.map(l => l.text).join('\n');
    assert.match(text, /작업표가 꽉 차서\(줄 2개 모두 참\) 구매양식 1건이 작업표에 들어가지 못했습니다\./);
    assert.match(text, /10\/26 11:48 주문 · 가짜리뷰어 · 연락처 끝 7564/);
    const raw = JSON.stringify(a);
    for (const pii of ['9750', '서울시', '111-222', '010-']) assert.ok(!raw.includes(pii), 'PII 노출: ' + pii);
  });
  await t('C2 입금관리 은행 목록·담당자 질문 목록에 섞이지 않는다', async () => {
    assert.equal((await ops.listChecks({})).length, 0);
    assert.equal((await manager.list({ db: pool, allowed: true })).items.length, 0);
  });
  const itemOf = async osId => (await slot.list({ db: pool, allowed: true })).items.find(i => i.facts.orderSubmissionId === osId);
  const admin = { role: 'master', name: '가짜 마스터' };
  await t('C3 [다시 넣기] — 작업표에 빈 줄이 없으면 거부하고 아무것도 바꾸지 않는다', async () => {
    const it = await itemOf(osA);
    await assert.rejects(slot.answer({ db: pool, id: it.id, choice: 'retry', admin, by: '가짜' }), e => e.code === 'no_room');
    assert.equal((await row(qA)).status, 'failed');
    assert.equal((await itemOf(osA)).status, 'open');
  });
  await t('C4 줄을 늘리면 매시 복구가 그 작업표의 막힌 행만 되살린다(주문 queued) · 다른 작업표는 그대로', async () => {
    await db.query(`INSERT INTO campaign_participants(sheet_id,tab_name,seq) VALUES ($1,$2,3)`, [OTHER.sheetId, OTHER.tabName]);
    const r = await sq.retryAllFailed();
    assert.equal(r.revivedNoSlot, 1);
    assert.equal((await row(qLegacy)).status, 'pending');
    assert.equal((await row(qLegacy)).attempts, 0);
    assert.equal((await order(osLegacy)).mirror_status, 'queued');
    assert.equal((await row(qA)).status, 'failed', '꽉 찬 작업표는 그대로');
    await slot.refresh(pool);
    const it = await itemOf(osLegacy);
    assert.equal(it.status, 'open', '다시 넣는 중에는 열어 둔다');
    assert.equal(it.queueState, 'retrying');
  });
  await t('C5 [다시 넣기] — 빈 줄이 생기면 기존 수동 재시도로 pending · 즉시 펌프 · 항목은 열어 둔다', async () => {
    await db.query(`INSERT INTO campaign_participants(sheet_id,tab_name,seq) VALUES ($1,$2,3)`, [FULL.sheetId, FULL.tabName]);
    const it = await itemOf(osA);
    const kicked = kicks.length;
    const out = await slot.answer({ db: pool, id: it.id, choice: 'retry', admin, by: '가짜' });
    assert.equal(out.status, 'open');
    assert.equal(out.queueState, 'retrying');
    const x = await row(qA);
    assert.equal(x.status, 'pending');
    assert.equal(x.attempts, 0);
    assert.equal((await order(osA)).mirror_status, 'queued');
    assert.equal(kicks.length, kicked + 1);
    const again = await slot.answer({ db: pool, id: it.id, choice: 'retry', admin, by: '가짜' });   // 두 번 눌러도 그대로
    assert.equal(again.queueState, 'retrying');
  });
  await t('C6 작업표에 들어가면 저절로 닫힌다(「작업표에 들어감」)', async () => {
    writeOut = { ok: true, written: true, seq: 3 };
    await db.query(`UPDATE campaign_participants SET order_submission_id=$1, workboard_id=$2 WHERE sheet_id=$3 AND seq=3`, [osA, WB, FULL.sheetId]);
    await db.query(`UPDATE order_submissions SET mirror_status='written' WHERE id=$1`, [osA]);
    await sq.drainOrderQueue(osA);
    assert.equal((await row(qA)).status, 'done');
    await slot.refresh(pool);
    const c = (await db.query(`SELECT * FROM ops_checks WHERE ref_key=$1`, [slot.refKeyOf(osA)])).rows[0];
    assert.equal(c.status, 'done');
    assert.equal(c.done_by, '작업표에 들어감');
  });
  await t('C7 [확인함] — 닫고, 여전히 막혀 있어도 다시 열지 않는다(큐 행·주문은 그대로)', async () => {
    writeOut = { ok: false, reason: 'no_open_slot' };
    const osB = await newOrder(FULL, { orderer: '두번째' });
    const qB = await enqueueFor(FULL, osB, 'failed', NO_SLOT_QUEUE_ERROR, 3);
    await db.query(`UPDATE campaign_participants SET deleted_at=now() WHERE sheet_id=$1 AND order_submission_id IS NULL`, [FULL.sheetId]);
    await slot.refresh(pool);
    const it = await itemOf(osB);
    const out = await slot.answer({ db: pool, id: it.id, choice: 'ack', admin, by: '가짜 직원' });
    assert.equal(out.status, 'done');
    assert.equal(out.doneBy, '가짜 직원');
    await slot.refresh(pool);
    assert.equal((await db.query(`SELECT status FROM ops_checks WHERE ref_key=$1`, [slot.refKeyOf(osB)])).rows[0].status, 'done');
    assert.equal((await row(qB)).status, 'failed');
    assert.equal(await itemOf(osB), undefined);
  });
  await t('C8 주문이 취소되면 저절로 닫힌다', async () => {
    const osC = await newOrder(FULL);
    await enqueueFor(FULL, osC, 'failed', NO_SLOT_QUEUE_ERROR, 3);
    await slot.refresh(pool);
    assert.ok(await itemOf(osC));
    await db.query(`UPDATE order_submissions SET deleted_at=now(), mirror_status='canceled' WHERE id=$1`, [osC]);
    await slot.refresh(pool);
    const c = (await db.query(`SELECT * FROM ops_checks WHERE ref_key=$1`, [slot.refKeyOf(osC)])).rows[0];
    assert.equal(c.status, 'done');
    assert.equal(c.done_by, '주문 취소됨');
  });
  await t('C9 권한 — 편집 명단 밖 admin 은 답할 수 없다 · 고르지 않은 답 거부', async () => {
    const osD = await newOrder(FULL);
    await enqueueFor(FULL, osD, 'failed', NO_SLOT_QUEUE_ERROR, 3);
    await slot.refresh(pool);
    const it = await itemOf(osD);
    await assert.rejects(slot.answer({ db: pool, id: it.id, choice: 'ack', admin: { role: 'admin', name: '명단밖' }, by: 'x' }), e => e.code === 'forbidden');
    await assert.rejects(slot.answer({ db: pool, id: it.id, choice: 'delete', admin, by: 'x' }), e => e.code === 'bad_choice');
    assert.equal((await itemOf(osD)).status, 'open');
  });

  // ═══ D. 실제 Express 라우트 ═══
  await db.exec(`CREATE TABLE workdesk_editors(name text, active boolean); INSERT INTO workdesk_editors VALUES ('가짜편집관리자', true);`);
  require('../src/utils/workdeskEditors').invalidate();
  process.env.JWT_SECRET = 'local-slot-fixture-only';
  const express = require('express'), jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json()); app.use('/api/trackb', require('../src/routes/trackB.routes'));
  app.use((e, req, res, next) => res.status(500).json({ ok: false, error: e.message }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/trackb/ops-checks`;
  const call = async (p, who, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + jwt.sign(who, process.env.JWT_SECRET);
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  try {
    await t('D1 로그인·역할 — 비로그인 401 · 직원/업체 403 · 관리자 200(명단 밖은 답 불가 표시)', async () => {
      for (const who of [null, { role: 'staff', name: '직원' }, { role: 'advertiser', name: '업체' }]) {
        assert.equal((await call('/slots', who)).status, who ? 403 : 401);
      }
      const r = await call('/slots', { role: 'admin', name: '명단밖' });
      assert.equal(r.status, 200);
      assert.ok(r.body.items.length >= 1);
      assert.ok(r.body.items.every(i => i.kind === 'workboard_no_slot' && i.canAnswer === false));
    });
    await t('D2 편집 관리자 — 답 저장 200 · 명단 밖 403 · 잘못된 id 400', async () => {
      const editor = { role: 'admin', name: '가짜편집관리자' };
      const r = await call('/slots', editor);
      const it = r.body.items[0];
      assert.equal(it.canAnswer, true);
      assert.equal((await call('/' + it.id + '/slot-answer', { role: 'admin', name: '명단밖' }, { choice: 'ack' })).status, 403);
      const ok = await call('/' + it.id + '/slot-answer', editor, { choice: 'ack' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.item.status, 'done');
      assert.equal((await call('/abc/slot-answer', editor, { choice: 'ack' })).status, 400);
      const bank = await call('', editor);
      assert.equal(bank.status, 200);
      assert.ok(bank.body.items.every(i => i.kind === 'bank_cluster'), '입금관리 목록에는 안 나온다');
    });
  } finally { server.close(); }

  console.log(`workboardNoSlotPg: ${passed}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
