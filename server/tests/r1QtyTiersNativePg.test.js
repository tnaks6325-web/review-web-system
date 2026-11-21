'use strict';
/**
 * r1QtyTiersNativePg.test.js — 결정 392(R1) 동시성 · **실제 PostgreSQL**(연결 여러 개 · 잠금 대기를 pg_blocking_pids 로 확인).
 *   선택 실행: R1_NATIVE_PG_TEST=1 (initdb 로 새 클러스터를 만들고 끝나면 지운다 — tests/helpers/captureNativePgFixture.js).
 *
 *   A1 R1 이 공고 행을 잡은 동안 리뷰어 신청 → 신청은 기다렸다가 R1 커밋 뒤 「새 단계」로 판정된다
 *   A2 신청이 먼저 공고 행을 잡음 → R1 은 기다렸다가 409 quantity_tiers_in_use · 아무것도 안 바뀜
 *   B1 바로 구매가 먼저 탭 잠금 → R1 은 기다렸다가 409 worktable_filled
 *   B2 R1 이 먼저 탭 잠금 → 바로 구매는 기다렸다가 R1 커밋 뒤 남은 235줄 안의 빈 줄로(정원 밖 새 줄 0)
 *   C  R1 ↔ 수동 「작업 삭제」(역순 잠금 1쌍 · J3) → 한쪽이 교착 감지로 끊기고(R1 이면 503 busy_retry) 데이터는 둘 중 하나의 완결 상태
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

if (process.env.R1_NATIVE_PG_TEST !== '1') {
  console.log('  ⏭ R1 동시성(실 PostgreSQL)은 R1_NATIVE_PG_TEST=1 일 때만');
  process.exit(0);
}

const { startNativeCaptureDatabase, gate, waitUntilBlocked } = require('./helpers/captureNativePgFixture');
const F = require('./helpers/r1QtyTiersFixture');
const SERVER = path.join(__dirname, '..');

let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

/** 연결마다 「문장 실행 뒤」 훅을 거는 pool 감싸개(앱·서비스가 쓰는 pool 자리에 끼운다). */
function hookedPool(pool) {
  const hooks = [];
  return {
    hooks,
    query: (...a) => pool.query(...a), on() {}, end: async () => {},
    connect: async () => {
      const c = await pool.connect();
      return { processID: c.processID,
        query: async (t, v) => { const out = await c.query(t, v); const sql = String(t && typeof t === 'object' ? t.text : t); for (const h of [...hooks]) await h(sql, c, v); return out; },
        release: (e) => c.release(e) };
    },
  };
}
const R1_CAMP_LOCK = /SELECT \* FROM recruit_campaigns WHERE id = \$1 AND archived_at IS NULL FOR UPDATE/;
const L1_LOCK = /pg_advisory_xact_lock\(hashtext\(\$1\)\)/;

(async () => {
  const cluster = await startNativeCaptureDatabase();
  console.log('  · ' + cluster.version.split(',')[0]);
  let H, dbPool = null;
  try {
    // 고정구 클러스터의 기본 DB 는 인코딩이 SQL_ASCII 라 한글이 안 들어간다 — UTF8 DB 를 따로 만든다(같은 클러스터 · 끝나면 통째로 지운다)
    await cluster.pool.query(`CREATE DATABASE r1test ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    const { Pool } = require('pg');
    dbPool = new Pool({ host: '127.0.0.1', port: cluster.port, user: 'capturetest', password: 'local-test-only', database: 'r1test', max: 10,
      connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000 -c lock_timeout=8000' });
    cluster.pool = dbPool;   // 아래 raw 연결도 같은 UTF8 DB
    const skipped = await F.applyMigrations(sql => dbPool.query(sql));
    if (skipped.length) console.log(`  · migrations 건너뜀 ${skipped.length}개(확장 등)`);
    const P = hookedPool(cluster.pool);
    const poolPath = require.resolve(path.join(SERVER, 'src/db/pool'));
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: P };
    H = await F.boot({ pool: P });
    const { setup, tierEdit } = H;
    const SERA_EDIT = p => { p[0].base.count = 235; p[0].base.daily = 24; p[0].qty_tiers.rows[2].people = 100; };
    const raw = cluster.pool;

    /** R1 저장을 「공고 행을 잡은 직후」 멈춰 세운다 → { pid, reached, release } */
    const pauseR1AfterCampLock = () => {
      const reached = gate(), release = gate(); let pid = null; let armed = true;
      const h = async (sql, c) => { if (armed && R1_CAMP_LOCK.test(sql)) { armed = false; pid = c.processID; reached.resolve(); await release.promise; } };
      P.hooks.push(h);
      return { reached: reached.promise, release: () => { release.resolve(); P.hooks.splice(P.hooks.indexOf(h), 1); }, pid: () => pid };
    };
    /** R1 저장 연결의 pid 만 잡는다(L1 잠금 문장 = applySharedPatch 연결) */
    const watchR1Pid = (woId) => {
      const got = gate(); let pid = null;
      const h = async (sql, c, v) => { if (!pid && L1_LOCK.test(sql) && v && String(v[0]).includes(woId)) { pid = c.processID; got.resolve(); } };
      P.hooks.push(h);
      return { got: got.promise, pid: () => pid, done: () => P.hooks.splice(P.hooks.indexOf(h), 1) };
    };

    await ok('A1 R1 이 공고 행을 잡은 동안 신청 → 신청은 실제로 기다리고, R1 커밋 뒤 새 단계(1개 100명)로 판정', async () => {
      const A = await setup('a1', F.SERAMO(400, F.T400));
      const pause = pauseR1AfterCampLock();
      const r1 = A.putSource(tierEdit(await A.wo(), SERA_EDIT), { tiers: 1 });
      await pause.reached;
      const c2 = await raw.connect();
      try {
        await c2.query('BEGIN');
        const lockP = c2.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [A.camp]);
        await waitUntilBlocked(raw, c2.processID, pause.pid());
        pause.release();
        const r = await r1;
        assert.equal(r.status, 200, JSON.stringify(r.body));
        await lockP;
        const qt = require('../src/services/campaignQtyTiers.service');
        const v = await qt.judge(c2, A.camp, null, 1);   // 신청 경로와 같은 판정(공고 행 잠금 안)
        assert.ok(v && v.ok, JSON.stringify(v));
        assert.equal(v.views.find(x => x.qty === 1).people, 100, '신청은 새 단계로 판정');
        await c2.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, purchase_qty, expires_at) VALUES ($1, '가짜신청', '71000001', 'applied', 1, NOW() + INTERVAL '1 hour')`, [A.camp]);
        await c2.query('COMMIT');
      } finally { c2.release(); }
      assert.equal(await A.rows(), 235);
      const again = await A.putSource(tierEdit(await A.wo(), p => { p[0].qty_tiers.rows[0].amount = 37000; }), { tiers: 1 });
      assert.equal(again.status, 409); assert.equal(again.body.code, 'quantity_tiers_in_use', '그 뒤로는 신청 1 → 막힘');
    });

    await ok('A2 신청이 먼저 공고 행을 잡음 → R1 은 실제로 기다렸다가 409 quantity_tiers_in_use · 아무것도 안 바뀜', async () => {
      const A = await setup('a2', F.SERAMO(400, F.T400));
      const before = await A.snapshot();
      const c2 = await raw.connect();
      let r;
      try {
        await c2.query('BEGIN');
        await c2.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [A.camp]);
        await c2.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, expires_at) VALUES ($1, '가짜신청', '71000002', 'applied', NOW() + INTERVAL '1 hour')`, [A.camp]);
        const w = watchR1Pid(A.w.id);
        const r1 = A.putSource(tierEdit(await A.wo(), SERA_EDIT), { tiers: 1 });
        await w.got; w.done();
        await waitUntilBlocked(raw, w.pid(), c2.processID);
        await c2.query('COMMIT');
        r = await r1;
      } finally { c2.release(); }
      assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'quantity_tiers_in_use');
      const after = JSON.parse(await A.snapshot()); const b = JSON.parse(before);
      assert.deepEqual({ ...after, ev: 0 }, { ...b, ev: 0 }, '오더·공고·단계 표·작업표·원본 번호 그대로');
    });

    // 바로 구매 = 실제 주문 기록 함수(writeOrderToWorktable · 탭 잠금 sheetless_worktable:)
    const so = require('../src/services/sheetlessOrder.service');
    const SP2 = hookedPool(raw);
    so.__setPoolForTest(SP2);
    const HEAD = { 번호: '', 수취인: '', 연락처: '', 주소: '', 결제금액: '', 주문번호: '' };
    const purchase = async (A, tag) => {
      const { rows } = await raw.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source)
        VALUES ($1, $2, '가짜구매', '가짜구매', '010-7200-0001', '12000', $3, 'queued', 'order_submit') RETURNING id`, [A.sheet, A.tab, 'SIM' + tag + Date.now()]);
      return so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
        orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: '010-7200-0001', price: '12000', orderNum: 'SIM' + tag } });
    };
    const withHeaders = async A => raw.query(`UPDATE campaign_participants SET row_json = $3::jsonb WHERE sheet_id = $1 AND tab_name = $2`, [A.sheet, A.tab, JSON.stringify(HEAD)]);
    const filledSeqs = async A => (await raw.query(`SELECT seq FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active AND order_submission_id IS NOT NULL ORDER BY seq`, [A.sheet, A.tab])).rows.map(r => Number(r.seq));

    await ok('B1 바로 구매가 먼저 탭 잠금 → R1 은 실제로 기다렸다가 409 worktable_filled · 오더·공고 그대로', async () => {
      const A = await setup('b1', F.SERAMO(400, F.T400)); await withHeaders(A);
      const reached = gate(), release = gate(); let ppid = null, armed = true;
      const h = async (sql, c, v) => { if (armed && L1_LOCK.test(sql) && v && String(v[0]).startsWith('sheetless_worktable:')) { armed = false; ppid = c.processID; reached.resolve(); await release.promise; } };
      SP2.hooks.push(h);
      const pw = purchase(A, 'b1');
      await reached.promise;
      const w = watchR1Pid(A.w.id);
      const before = JSON.parse(await A.snapshot());
      const r1 = A.putSource(tierEdit(await A.wo(), SERA_EDIT), { tiers: 1 });
      await w.got; w.done();
      await waitUntilBlocked(raw, w.pid(), ppid);
      release.resolve(); SP2.hooks.splice(SP2.hooks.indexOf(h), 1);
      const pr = await pw;
      assert.equal(pr.ok, true, JSON.stringify(pr));
      const r = await r1;
      assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'worktable_filled');
      const after = JSON.parse(await A.snapshot());
      for (const k of ['src', 'ver', 'poj', 'pay', 'rc', 'crt', 'cdl', 'tiers', 'rows']) assert.deepEqual(after[k], before[k], k);
    });

    await ok('B2 R1 이 먼저 탭 잠금 → 바로 구매는 실제로 기다렸다가 R1 커밋 뒤 남은 235줄 안으로(정원 밖 새 줄 0)', async () => {
      const A = await setup('b2', F.SERAMO(400, F.T400)); await withHeaders(A);
      const pause = pauseR1AfterCampLock();
      const r1 = A.putSource(tierEdit(await A.wo(), SERA_EDIT), { tiers: 1 });
      await pause.reached;
      const got = gate(); let ppid = null;
      const h = async (sql, c) => { if (!ppid) { ppid = c.processID; got.resolve(); } };
      SP2.hooks.push(h);
      const pw = purchase(A, 'b2');
      await got.promise; SP2.hooks.splice(SP2.hooks.indexOf(h), 1);
      await waitUntilBlocked(raw, ppid, pause.pid());
      pause.release();
      const r = await r1;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const pr = await pw;
      assert.equal(pr.ok, true, JSON.stringify(pr));
      assert.equal(await A.rows(), 235, '줄 수 = 새 총원');
      const seqs = await filledSeqs(A);
      assert.equal(seqs.length, 1); assert.ok(seqs[0] <= 235, '남은 줄 안의 빈 줄 ' + seqs);
    });

    await ok('C R1 ↔ 수동 작업 삭제(역순 잠금 1쌍 · J3) — 한쪽만 끊기고 데이터는 둘 중 하나의 완결 상태', async () => {
      const A = await setup('c', F.SERAMO(400, F.T400));
      const before = JSON.parse(await A.snapshot());
      const pause = pauseR1AfterCampLock();
      const r1 = A.putSource(tierEdit(await A.wo(), SERA_EDIT), { tiers: 1 });
      await pause.reached;
      const DP = hookedPool(raw); const got = gate(); let dpid = null;
      DP.hooks.push(async (sql, c) => { if (!dpid) { dpid = c.processID; got.resolve(); } });
      const del = require('../src/services/workTabDelete.service').deleteTask({ sheetId: A.sheet, tabName: A.tab, confirm: true, pool: DP, notifyIntranet: false, by: '시험' })
        .then(x => ({ ok: true, x }), e => ({ ok: false, e }));
      await got.promise;
      await waitUntilBlocked(raw, dpid, pause.pid());
      pause.release();
      const [r, d] = [await r1, await del];
      const wo = await A.wo();
      const campLeft = (await raw.query('SELECT 1 FROM recruit_campaigns WHERE id = $1', [A.camp])).rows.length;
      console.log(`    · R1=${r.status} ${r.body.code || 'ok'} · 삭제=${d.ok ? (d.x && d.x.ok ? '성공' : (d.x && d.x.code)) : (d.e && d.e.code)}`);
      if (r.status === 200) {
        // R1 이 이겼다 — 작업 삭제는 교착으로 끊기거나 R1 뒤에 실행됐다
        assert.deepEqual(JSON.parse(wo.product_options_json)[0].qty_tiers.rows.map(x => x.people), [30, 105, 100]);
        if (!(d.ok && d.x && d.x.ok)) { assert.equal(campLeft, 1); assert.deepEqual((await A.tiers()).map(t => t[3]), [30, 105, 100]); assert.equal(await A.rows(), 235); }
      } else {
        assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'busy_retry');
        assert.equal(Number(wo.source_revision), before.src, '원본 번호 그대로(인트라넷이 같은 번호로 다시 보낸다)');
        assert.equal(wo.product_options_json, before.poj, '오더 단계 그대로');
        assert.ok(d.ok && d.x && d.x.ok, '작업 삭제는 끝까지 ' + JSON.stringify(d.x || String(d.e)));
      }
      assert.ok(r.status === 200 || (d.ok && d.x && d.x.ok), '둘 다 실패하지 않는다');
    });
  } finally {
    if (H) await H.close().catch(() => {});
    if (dbPool) await dbPool.end().catch(() => {});
    await cluster.close().catch(() => {});   // 기본 DB 연결 닫기 + 클러스터 정지
    fs.rmSync(cluster.dir, { recursive: true, force: true });
  }
  console.log(`r1QtyTiersNativePg: ${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
