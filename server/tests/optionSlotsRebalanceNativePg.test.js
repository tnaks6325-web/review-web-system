'use strict';
/**
 * optionSlotsRebalanceNativePg.test.js — 결정 394 동시성 · **실제 PostgreSQL**(연결 여러 개 · 잠금 대기를 pg_blocking_pids 로 확인).
 *   선택 실행: OS_NATIVE_PG_TEST=1 (initdb 로 새 클러스터를 만들고 끝나면 지운다 — tests/helpers/captureNativePgFixture.js · UTF8 DB 따로).
 *
 *   B1 저장(옵션 인원 변경)이 빈 줄 표시를 다시 쓴 직후(전 줄 잠금 + 탭 잠금) 바로 구매 → 바로 구매는 SKIP LOCKED 로 건너뛰지 않고
 *      탭 잠금에서 실제로 기다렸다가, 저장 커밋 뒤 새 표시의 그 옵션 빈 줄로(정원 밖 새 줄 0 · no_open_slot 보류 0)
 *   B2 바로 구매가 먼저 탭 잠금 → 저장은 공고 행보다 먼저 탭 잠금에서 기다렸다가, 그 구매를 정원 셈 규칙으로 센 뒤 다시 나눔
 *   A  저장이 다시 나누는 동안 리뷰어 신청(공고 행 FOR UPDATE) → 신청은 기다렸다가 저장 커밋 뒤 진행
 *   C  저장 ↔ 수동 「작업 삭제」 → 둘 중 하나의 완결 상태(교착 감지로 끊기면 503 busy_retry 또는 삭제 쪽 40P01)
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

if (process.env.OS_NATIVE_PG_TEST !== '1') {
  console.log('  ⏭ 옵션 줄 다시 나누기 동시성(실 PostgreSQL)은 OS_NATIVE_PG_TEST=1 일 때만');
  process.exit(0);
}

const { startNativeCaptureDatabase, gate, waitUntilBlocked } = require('./helpers/captureNativePgFixture');
const F = require('./helpers/r1QtyTiersFixture');
const SERVER = path.join(__dirname, '..');

let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

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
const REBALANCE_WRITE = /UPDATE campaign_participants cp SET option_text = v\.ot/;
const L1_LOCK = /pg_advisory_xact_lock\(hashtext\(\$1\)\)/;
const OPTP = (b, w) => ([{ name: '티셔츠', url: 'https://www.coupang.com/vp/products/701', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: [['블루', b], ['라지', w]].map(([v, count]) => ({ option_1: { name: '', value: v }, label: v, url: '', pay: 10000, count, daily: 1, review_type_mix: [] })) }]);

(async () => {
  const cluster = await startNativeCaptureDatabase();
  console.log('  · ' + cluster.version.split(',')[0]);
  let H, dbPool = null;
  try {
    // 고정구 클러스터 기본 DB 는 SQL_ASCII — 한글이 깨지지 않게 UTF8 DB 를 따로 만든다(같은 클러스터 · 끝나면 통째로 지운다)
    await cluster.pool.query(`CREATE DATABASE ostest ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    const { Pool } = require('pg');
    dbPool = new Pool({ host: '127.0.0.1', port: cluster.port, user: 'capturetest', password: 'local-test-only', database: 'ostest', max: 10,
      connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000 -c lock_timeout=8000' });
    cluster.pool = dbPool;
    const skipped = await F.applyMigrations(sql => dbPool.query(sql));
    if (skipped.length) console.log(`  · migrations 건너뜀 ${skipped.length}개(확장 등)`);
    const P = hookedPool(cluster.pool);
    const poolPath = require.resolve(path.join(SERVER, 'src/db/pool'));
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: P };
    H = await F.boot({ pool: P });
    const { setup, tierEdit } = H;
    const raw = cluster.pool;
    const so = require('../src/services/sheetlessOrder.service');
    const SP2 = hookedPool(raw);
    so.__setPoolForTest(SP2);

    const paint = A => raw.query(`UPDATE campaign_participants SET option_text = CASE WHEN seq % 2 = 1 THEN '블루' ELSE '라지' END,
        row_json = jsonb_build_object('번호', seq::text, '상품', '티셔츠', '옵션', CASE WHEN seq % 2 = 1 THEN '블루' ELSE '라지' END, '수취인', '', '연락처', '', '주문번호', '', '결제금액', '')
      WHERE sheet_id = $1 AND tab_name = $2`, [A.sheet, A.tab]);
    const emptyCounts = async A => { const { rows } = await raw.query(`SELECT option_text l, COUNT(*)::int n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active AND order_submission_id IS NULL GROUP BY 1 ORDER BY 1`, [A.sheet, A.tab]);
      return Object.fromEntries(rows.map(r => [r.l, r.n])); };
    let osn = 0;
    const purchase = async (A, optKey) => {
      osn += 1;
      const { rows } = await raw.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source, selected_opt_key, selected_product)
        VALUES ($1, $2, '가짜구매', '가짜구매', $3, '10000', $4, 'queued', 'order_submit', $5, '') RETURNING id`, [A.sheet, A.tab, `010-7400-${1000 + osn}`, `OSN${osn}${Date.now()}`, optKey]);
      const w = await so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
        orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: `010-7400-${1000 + osn}`, price: '10000', orderNum: `OSN${osn}`, selectedOptKey: optKey } });
      const { rows: got } = await raw.query('SELECT seq, option_text FROM campaign_participants WHERE order_submission_id = $1 AND deleted_at IS NULL', [rows[0].id]);
      return { w, row: got[0] };
    };
    const save73 = async A => A.putSource(tierEdit(await A.wo(), p => { p[0].options[0].count = 7; p[0].options[1].count = 3; }));
    /** 저장을 「빈 줄 표시를 다시 쓴 직후」(전 줄·탭·공고 행 잠금을 쥔 채) 멈춘다 */
    const pauseAfterRebalanceWrite = () => {
      const reached = gate(), release = gate(); let pid = null; let armed = true;
      const h = async (sql, c) => { if (armed && REBALANCE_WRITE.test(sql)) { armed = false; pid = c.processID; reached.resolve(); await release.promise; } };
      P.hooks.push(h);
      return { reached: reached.promise, release: () => { release.resolve(); P.hooks.splice(P.hooks.indexOf(h), 1); }, pid: () => pid };
    };

    await ok('B1 다시 나누는 중(전 줄 잠금) 바로 구매 → 탭 잠금에서 실제로 기다렸다가 새 표시의 라지 빈 줄로 · 정원 밖 새 줄 0 · 보류 0', async () => {
      const A = await setup('b1', OPTP(5, 5)); await paint(A);
      const pause = pauseAfterRebalanceWrite();
      const sv = save73(A);
      await pause.reached;
      const got = gate(); let ppid = null;
      const h = async (sql, c) => { if (!ppid) { ppid = c.processID; got.resolve(); } };
      SP2.hooks.push(h);
      const pw = purchase(A, '라지');
      await got.promise; SP2.hooks.splice(SP2.hooks.indexOf(h), 1);
      try { await waitUntilBlocked(raw, ppid, pause.pid()); }   // ★ 건너뛰지(SKIP LOCKED) 않고 기다린다
      catch (e) { pause.release(); const early = await pw; await sv; throw new Error(`${e.message} · 바로 구매가 기다리지 않고 끝남: ${JSON.stringify(early.w)} · 줄 ${await A.rows()}`); }
      pause.release();
      const r = await sv;
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.option_slots.status, 'applied', JSON.stringify(r.body.option_slots));
      const pr = await pw;
      assert.equal(pr.w.ok, true, '보류(no_open_slot) 0 ' + JSON.stringify(pr.w));
      assert.equal(pr.row.option_text, '라지');
      assert.equal(await A.rows(), 10, '정원 밖 새 줄 0');
      assert.deepEqual(await emptyCounts(A), { 라지: 2, 블루: 7 });
    });

    await ok('B2 바로 구매가 먼저 탭 잠금 → 저장은 공고 행보다 먼저 탭 잠금에서 기다렸다가 그 구매(라지)를 세고 다시 나눔', async () => {
      const A = await setup('b2', OPTP(5, 5)); await paint(A);
      const reached = gate(), release = gate(); let ppid = null, armed = true;
      const h = async (sql, c, v) => { if (armed && L1_LOCK.test(sql) && v && String(v[0]).startsWith('sheetless_worktable:')) { armed = false; ppid = c.processID; reached.resolve(); await release.promise; } };
      SP2.hooks.push(h);
      const pw = purchase(A, '라지');
      await reached.promise;
      const got = gate(); let spid = null;
      const hs = async (sql, c, v) => { if (!spid && L1_LOCK.test(sql) && v && String(v[0]).includes(A.w.id)) { spid = c.processID; got.resolve(); } };
      P.hooks.push(hs);
      const sv = save73(A);
      await got.promise; P.hooks.splice(P.hooks.indexOf(hs), 1);
      try { await waitUntilBlocked(raw, spid, ppid); }
      catch (e) { release.resolve(); await pw; const r0 = await sv; throw new Error(`${e.message} · 저장이 탭 잠금을 기다리지 않음: ${JSON.stringify(r0.body.option_slots)}`); }
      const { rows: campLocked } = await raw.query(`SELECT COUNT(*)::int n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = $1 AND c.relname = 'recruit_campaigns' AND l.mode = 'RowShareLock'`, [spid]);
      assert.equal(campLocked[0].n, 0, '저장은 공고 행을 아직 안 잡고 탭 잠금에서 기다린다(잠금 순서)');
      release.resolve(); SP2.hooks.splice(SP2.hooks.indexOf(h), 1);
      const pr = await pw; assert.equal(pr.w.ok, true, JSON.stringify(pr.w));
      const r = await sv;
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.option_slots.status, 'applied', JSON.stringify(r.body.option_slots));
      assert.equal(r.body.option_slots.options.find(o => o.option === '라지').filled, 1, '바로 구매를 정원 셈 규칙으로 셈');
      assert.equal(await A.rows(), 10);
      assert.deepEqual(await emptyCounts(A), { 라지: 2, 블루: 7 });
    });

    await ok('A 다시 나누는 동안 리뷰어 신청(공고 행 FOR UPDATE) → 신청은 기다렸다가 저장 커밋 뒤 진행', async () => {
      const A = await setup('a', OPTP(5, 5)); await paint(A);
      const pause = pauseAfterRebalanceWrite();
      const sv = save73(A);
      await pause.reached;
      const c2 = await raw.connect();
      try {
        await c2.query('BEGIN');
        const lockP = c2.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [A.camp]);
        await waitUntilBlocked(raw, c2.processID, pause.pid());
        pause.release();
        const r = await sv;
        assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.option_slots.status, 'applied');
        await lockP;
        const { rows: o } = await c2.query(`SELECT opt_key, recruit_total FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order`, [A.camp]);
        assert.deepEqual(o.map(x => [x.opt_key, Number(x.recruit_total)]), [['블루', 7], ['라지', 3]], '신청은 새 인원을 본다');
        await c2.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at) VALUES ($1, '가짜신청', '74000001', 'applied', '라지', NOW() + INTERVAL '1 hour')`, [A.camp]);
        await c2.query('COMMIT');
      } finally { c2.release(); }
      assert.equal(await A.rows(), 10);
      assert.deepEqual(await emptyCounts(A), { 라지: 3, 블루: 7 });
    });

    await ok('C 저장 ↔ 수동 작업 삭제 — 둘 중 하나의 완결 상태(한쪽만 교착 감지로 끊김)', async () => {
      const A = await setup('c', OPTP(5, 5)); await paint(A);
      const pause = pauseAfterRebalanceWrite();
      const sv = save73(A);
      await pause.reached;
      const DP = hookedPool(raw); const got = gate(); let dpid = null;
      DP.hooks.push(async (sql, c) => { if (!dpid) { dpid = c.processID; got.resolve(); } });
      const del = require('../src/services/workTabDelete.service').deleteTask({ sheetId: A.sheet, tabName: A.tab, confirm: true, pool: DP, notifyIntranet: false, by: '시험' })
        .then(x => ({ ok: true, x }), e => ({ ok: false, e }));
      await got.promise;
      await waitUntilBlocked(raw, dpid, pause.pid());
      pause.release();
      const [r, d] = [await sv, await del];
      const left = Number((await raw.query(`SELECT COUNT(*)::int n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active`, [A.sheet, A.tab])).rows[0].n);
      console.log(`    · 저장=${r.status} ${r.body.code || (r.body.option_slots && r.body.option_slots.status)} · 삭제=${d.ok ? (d.x && d.x.ok ? '성공' : (d.x && d.x.code)) : (d.e && d.e.code)} · 남은 줄 ${left}`);
      if (r.status === 200 && !(d.ok && d.x && d.x.ok)) assert.deepEqual(await emptyCounts(A), { 라지: 3, 블루: 7 }, '저장만 끝남 = 다시 나눈 상태');
      if (d.ok && d.x && d.x.ok) assert.equal(left, 0, '삭제가 끝났으면 줄이 남지 않는다');
      if (r.status !== 200) { assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'busy_retry'); }
      assert.ok(r.status === 200 || (d.ok && d.x && d.x.ok), '둘 다 실패하지 않는다');
    });
  } finally {
    if (H) await H.close().catch(() => {});
    if (dbPool) await dbPool.end().catch(() => {});
    await cluster.close().catch(() => {});
    fs.rmSync(cluster.dir, { recursive: true, force: true });
  }
  console.log(`optionSlotsRebalanceNativePg: ${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
