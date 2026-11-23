'use strict';
/**
 * optionRenameV2SlotsNativePg.test.js — 결정 401 동시성 · **실제 PostgreSQL**(연결 여러 개 · 잠금 대기를 pg_blocking_pids 로 확인).
 *   선택 실행: RN_NATIVE_PG_TEST=1 (initdb 로 새 클러스터를 만들고 끝나면 지운다 — tests/helpers/captureNativePgFixture.js · UTF8 DB 따로).
 *
 *   N1 이름 바꾸기가 v2 빈 줄을 다시 쓴 직후(빈 줄 전부 FOR UPDATE · 공고 행 잠금을 쥔 채) 바로 구매 — v1 작업보드와 v2 작업보드의 결과가 같다
 *      (이름 바꾸기의 잠금 범위는 v1 그대로 · v2 줄도 원래 같은 SELECT … FOR UPDATE 로 잠겨 있었다)
 *   N2 바로 구매가 고른 빈 줄을 먼저 잠금 → 이름 바꾸기는 실제로 기다렸다가, 구매 커밋 뒤 그 줄(이제 채운 줄)은 옛 이름 그대로 · 나머지 빈 줄만 새 이름
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

if (process.env.RN_NATIVE_PG_TEST !== '1') {
  console.log('  ⏭ 옵션 이름 바꾸기 v2 빈 줄 동시성(실 PostgreSQL)은 RN_NATIVE_PG_TEST=1 일 때만');
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
        query: async (t, v) => { const sql = String(t && typeof t === 'object' ? t.text : t); for (const h of [...hooks]) if (h.before) await h.before(sql, c, v); const out = await c.query(t, v); for (const h of [...hooks]) if (h.after) await h.after(sql, c, v); return out; },
        release: (e) => c.release(e) };
    },
  };
}
const RENAME_WRITE = /updated_by = 'option-rename'/;
const SKIP_LOCKED_PICK = /FOR UPDATE SKIP LOCKED/;
const OPTP = () => ([{ name: '티셔츠', url: 'https://www.coupang.com/vp/products/703', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: [['블루', 2], ['XL', 2]].map(([v, count]) => ({ option_1: { name: '', value: v }, label: v, url: '', pay: 10000, count, daily: 1, review_type_mix: [] })) }]);

(async () => {
  const cluster = await startNativeCaptureDatabase();
  console.log('  · ' + cluster.version.split(',')[0]);
  let H, dbPool = null;
  try {
    await cluster.pool.query(`CREATE DATABASE rntest ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    const { Pool } = require('pg');
    dbPool = new Pool({ host: '127.0.0.1', port: cluster.port, user: 'capturetest', password: 'local-test-only', database: 'rntest', max: 10,
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

    const paint = (A, v2) => raw.query(`UPDATE campaign_participants SET option_text = CASE WHEN seq % 2 = 1 THEN $3 ELSE $4 END,
        row_json = jsonb_build_object('번호', seq::text, '상품', '티셔츠', '1차옵션', CASE WHEN seq % 2 = 1 THEN '블루' ELSE 'XL' END, '수취인', '', '연락처', '', '주문번호', '', '결제금액', '')
      WHERE sheet_id = $1 AND tab_name = $2`, [A.sheet, A.tab, v2 ? '티셔츠 · 블루' : '블루', v2 ? '티셔츠 · XL' : 'XL']);
    const labels = async A => (await raw.query(`SELECT seq, option_text, order_submission_id IS NOT NULL AS filled FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq`, [A.sheet, A.tab])).rows;
    let osn = 0;
    const purchase = async (A, optKey) => {
      osn += 1;
      const { rows } = await raw.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source, selected_opt_key, selected_product)
        VALUES ($1, $2, '가짜구매', '가짜구매', $3, '10000', $4, 'queued', 'order_submit', $5, '') RETURNING id`, [A.sheet, A.tab, `010-7500-${1000 + osn}`, `RNN${osn}${Date.now()}`, optKey]);
      const w = await so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
        orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: `010-7500-${1000 + osn}`, price: '10000', orderNum: `RNN${osn}`, selectedOptKey: optKey } });
      const { rows: got } = await raw.query('SELECT seq, option_text FROM campaign_participants WHERE order_submission_id = $1 AND deleted_at IS NULL', [rows[0].id]);
      return { w, row: got[0] };
    };
    const rename = async A => {
      const cur = await A.wo(); const p = JSON.parse(cur.product_options_json);
      p[0].options[1] = { ...p[0].options[1], prev_label: 'XL', label: '엑스라지', option_1: { name: '', value: '엑스라지' } };
      return A.putSource(tierEdit({ ...cur, product_options_json: JSON.stringify(p) }, () => {}), { structure: 1, rename: 1 });
    };

    /** N1 — 이름 바꾸기를 「빈 줄을 다시 쓴 직후」 멈추고 바로 구매(블루 · 이름 안 바뀐 옵션) — 결과 기록 */
    const n1 = async (tag, v2) => {
      const A = await setup(tag, OPTP()); await paint(A, v2);
      const reached = gate(), release = gate(); let rpid = null, armed = true;
      const h = { after: async (sql, c) => { if (armed && RENAME_WRITE.test(sql)) { armed = false; rpid = c.processID; reached.resolve(); await release.promise; } } };
      P.hooks.push(h);
      const rv = rename(A);
      await reached.promise;
      const got = gate(); let ppid = null;
      const hp = { before: async (sql, c) => { if (!ppid) { ppid = c.processID; got.resolve(); } } };
      SP2.hooks.push(hp);
      const pw = purchase(A, '블루');
      await got.promise; SP2.hooks.splice(SP2.hooks.indexOf(hp), 1);
      let waited = true;
      try { await waitUntilBlocked(raw, ppid, rpid); } catch (_) { waited = false; }
      release.resolve(); P.hooks.splice(P.hooks.indexOf(h), 1);
      const r = await rv; assert.equal(r.status, 200, JSON.stringify(r.body));
      const pr = await pw;
      return { waited, ok: pr.w.ok, reason: pr.w.reason || null, seated: !!(pr.row && Number(pr.row.seq) <= 4), rows: await A.rows() };
    };

    await ok('N1 이름 바꾸는 중 바로 구매 — v1 작업보드와 v2 작업보드의 결과가 같다(잠금 범위 v1 그대로)', async () => {
      const a = await n1('n1v1', false), b = await n1('n1v2', true);
      console.log('    · v1 ' + JSON.stringify(a) + ' / v2 ' + JSON.stringify(b));
      assert.deepEqual(b, a);
    });

    await ok('N2 바로 구매가 고른 빈 줄을 먼저 잠금 → 이름 바꾸기는 실제로 기다렸다가 · 그 줄(채운 줄)은 옛 이름 · 나머지 XL 빈 줄만 새 이름', async () => {
      const A = await setup('n2', OPTP()); await paint(A, true);
      const reached = gate(), release = gate(); let ppid = null, armed = true;
      const hp = { after: async (sql, c) => { if (armed && SKIP_LOCKED_PICK.test(sql)) { armed = false; ppid = c.processID; reached.resolve(); await release.promise; } } };
      SP2.hooks.push(hp);
      const pw = purchase(A, 'XL');
      await reached.promise;
      const rv = rename(A);
      // 이름 바꾸기 연결 가운데 하나가 바로 구매(ppid)를 실제로 기다리는지(pg_blocking_pids) — 어느 잠금에서든
      let waitedOn = false;
      for (const end = Date.now() + 3500; Date.now() < end && !waitedOn;) {
        const { rows } = await raw.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [ppid]);
        if (rows.length) waitedOn = true; else await new Promise(r => setTimeout(r, 15));
      }
      if (!waitedOn) { release.resolve(); await pw; await rv; throw new Error('이름 바꾸기가 바로 구매를 기다리지 않았다'); }
      release.resolve(); SP2.hooks.splice(SP2.hooks.indexOf(hp), 1);
      const pr = await pw; assert.equal(pr.w.ok, true, JSON.stringify(pr.w));
      const r = await rv; assert.equal(r.status, 200, JSON.stringify(r.body));
      const ls = await labels(A);
      const filled = ls.filter(x => x.filled);
      assert.equal(filled.length, 1);
      assert.notEqual(filled[0].option_text, '티셔츠 · 엑스라지', '채운 줄은 새 이름으로 안 바뀐다');
      assert.deepEqual(ls.filter(x => !x.filled).map(x => x.option_text).sort(), ['티셔츠 · 블루', '티셔츠 · 블루', '티셔츠 · 엑스라지'].sort());
      const pr2 = await purchase(A, '엑스라지');
      assert.equal(pr2.w.ok, true, JSON.stringify(pr2.w)); assert.ok(Number(pr2.row.seq) <= 4, '새 이름 주문 = 남은 빈 줄'); assert.equal(await A.rows(), 4);
    });
    console.log(`optionRenameV2SlotsNativePg: ${passed} passed`);
  } finally {
    if (H) await H.close().catch(() => {});
    if (dbPool) await dbPool.end().catch(() => {});
    await cluster.close().catch(() => {});
    fs.rmSync(cluster.dir, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
