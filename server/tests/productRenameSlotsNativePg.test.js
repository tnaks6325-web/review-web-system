'use strict';
/**
 * productRenameSlotsNativePg.test.js — 결정 405 동시성 · **실제 PostgreSQL**(연결 여러 개 · 잠금 대기를 pg_blocking_pids 로 확인).
 *   선택 실행: PR_NATIVE_PG_TEST=1 (initdb 로 새 클러스터를 만들고 끝나면 그 폴더만 지운다 — tests/helpers/captureNativePgFixture.js · UTF8 DB 따로).
 *   상품 2개(고등어 · 고등어 2팩 세트) v2 작업보드 · 양방향 공유 저장으로 고등어 → 국산 고등어.
 *   N1 상품 이름 바꾸기가 빈 줄을 다시 쓴 직후(빈 줄 전부 FOR UPDATE 를 쥔 채) 바로 구매 — v1 작업보드와 v2 작업보드의 결과가 같다(잠금 범위 종전 그대로)
 *   N2 바로 구매가 고른 빈 줄을 먼저 잠금 → 이름 바꾸기는 실제로 기다렸다가, 그 줄(이제 채운 줄)은 옛 이름 · 남은 고등어 빈 줄만 새 이름 · 새 이름 주문 = 남은 빈 줄
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

if (process.env.PR_NATIVE_PG_TEST !== '1') {
  console.log('  ⏭ 상품 이름 바꾸기 빈 줄 동시성(실 PostgreSQL)은 PR_NATIVE_PG_TEST=1 일 때만');
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
const RENAME_WRITE = /updated_by = 'option-rename'/;   // 빈 줄 다시 쓰기(상품 이름 바꾸기도 같은 표시)
const SKIP_LOCKED_PICK = /FOR UPDATE SKIP LOCKED/;
const OPTP = () => [['고등어', ['1kg', '2kg']], ['고등어 2팩 세트', ['기본', '선물']]].map(([name, vs], i) => ({ name, url: `https://www.coupang.com/vp/products/90${i}`, option_schema_version: 2, product_mode: 'opt',
  base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: vs.map(v => ({ option_1: { name: '', value: v }, label: v, url: '', pay: 10000, count: 2, daily: 1, review_type_mix: [] })) }));
// seq 1·2 고등어 1kg · 3·4 고등어 2kg · 5·6 2팩 세트 기본 · 7·8 2팩 세트 선물

(async () => {
  const cluster = await startNativeCaptureDatabase();
  console.log('  · ' + cluster.version.split(',')[0]);
  let H, dbPool = null;
  try {
    await cluster.pool.query(`CREATE DATABASE prtest ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    const { Pool } = require('pg');
    dbPool = new Pool({ host: '127.0.0.1', port: cluster.port, user: 'capturetest', password: 'local-test-only', database: 'prtest', max: 10,
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

    const paint = (A, v2) => raw.query(`WITH p AS (SELECT id, seq, CASE WHEN seq <= 4 THEN '고등어' ELSE '고등어 2팩 세트' END AS pn,
          CASE WHEN seq <= 2 THEN '1kg' WHEN seq <= 4 THEN '2kg' WHEN seq <= 6 THEN '기본' ELSE '선물' END AS o FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2)
      UPDATE campaign_participants cp SET option_text = CASE WHEN $3 THEN p.pn || ' · ' || p.o ELSE p.o END,
        row_json = jsonb_build_object('번호', p.seq::text, '상품', p.pn, '1차옵션', p.o, '수취인', '', '연락처', '', '주문번호', '', '결제금액', '')
      FROM p WHERE cp.id = p.id`, [A.sheet, A.tab, !!v2]);
    const labels = async A => (await raw.query(`SELECT seq, option_text, order_submission_id IS NOT NULL AS filled FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq`, [A.sheet, A.tab])).rows;
    let osn = 0;
    // 공고 참여(신청 기록)로 산 주문 — 줄 고르기가 그 신청의 공고 옵션 상품 이름으로 「상품 · 옵션」 줄을 고른다.
    //   신청·주문 원장은 먼저 만든다(실제로도 신청은 구매 전) — 이름 바꾸기가 공고 행을 잠근 동안 신청 INSERT 의 외래키 확인이 기다리지 않게.
    const prepare = async (A, optKey) => {
      osn += 1;
      const n = osn;
      const app = (await raw.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at)
        VALUES ($1, '가짜참여', $2, 'applied', $3, NOW() + INTERVAL '1 hour') RETURNING id`, [A.camp, String(76001000 + n), optKey])).rows[0].id;
      const { rows } = await raw.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source, selected_opt_key, selected_product, campaign_application_id)
        VALUES ($1, $2, '가짜구매', '가짜구매', $3, '10000', $4, 'queued', 'order_submit', $5, '', $6) RETURNING id`, [A.sheet, A.tab, `010-7600-${1000 + n}`, `PRN${n}${Date.now()}`, optKey, app]);
      return async () => {
        const w = await so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
          orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: `010-7600-${1000 + n}`, price: '10000', orderNum: `PRN${n}`, selectedOptKey: optKey } });
        const { rows: got } = await raw.query('SELECT seq, option_text FROM campaign_participants WHERE order_submission_id = $1 AND deleted_at IS NULL', [rows[0].id]);
        return { w, row: got[0] };
      };
    };
    const purchase = async (A, optKey) => (await prepare(A, optKey))();
    const rename = async A => {
      const cur = await A.wo(); const p = JSON.parse(cur.product_options_json);
      p[0] = { ...p[0], prev_name: '고등어', name: '국산 고등어' };
      return A.putSource(tierEdit({ ...cur, product_options_json: JSON.stringify(p) }, () => {}), { structure: 1, rename: 1 });
    };

    /** N1 — 상품 이름 바꾸기를 「빈 줄을 다시 쓴 직후」 멈추고 바로 구매(기본 · 이름 안 바뀐 상품) — 결과 기록 */
    const n1 = async (tag, v2) => {
      const A = await setup(tag, OPTP()); await paint(A, v2);
      const buy = await prepare(A, '기본');
      const reached = gate(), release = gate(); let rpid = null, armed = true;
      const h = { after: async (sql, c) => { if (armed && RENAME_WRITE.test(sql)) { armed = false; rpid = c.processID; reached.resolve(); await release.promise; } } };
      P.hooks.push(h);
      const rv = rename(A);
      await reached.promise;
      const got = gate(); let ppid = null;
      const hp = { before: async (sql, c) => { if (!ppid) { ppid = c.processID; got.resolve(); } } };
      SP2.hooks.push(hp);
      const pw = buy();
      await got.promise; SP2.hooks.splice(SP2.hooks.indexOf(hp), 1);
      let waited = true;
      try { await waitUntilBlocked(raw, ppid, rpid); } catch (_) { waited = false; }
      release.resolve(); P.hooks.splice(P.hooks.indexOf(h), 1);
      const r = await rv; assert.equal(r.status, 200, JSON.stringify(r.body));
      const pr = await pw;
      return { waited, ok: pr.w.ok, reason: pr.w.reason || null, seated: !!(pr.row && [5, 6].includes(Number(pr.row.seq))), rows: await A.rows() };
    };

    await ok('N1 상품 이름 바꾸는 중 바로 구매 — v1 작업보드와 v2 작업보드의 결과가 같다(잠금 범위 종전 그대로)', async () => {
      const a = await n1('n1v1', false), b = await n1('n1v2', true);
      console.log('    · v1 ' + JSON.stringify(a) + ' / v2 ' + JSON.stringify(b));
      assert.deepEqual(b, a);
    });

    await ok('N2 바로 구매가 고른 빈 줄을 먼저 잠금 → 상품 이름 바꾸기는 실제로 기다렸다가 · 그 줄(채운 줄)은 옛 이름 · 남은 고등어 빈 줄만 새 이름', async () => {
      const A = await setup('n2', OPTP()); await paint(A, true);
      const reached = gate(), release = gate(); let ppid = null, armed = true;
      const hp = { after: async (sql, c) => { if (armed && SKIP_LOCKED_PICK.test(sql)) { armed = false; ppid = c.processID; reached.resolve(); await release.promise; } } };
      SP2.hooks.push(hp);
      const pw = purchase(A, '1kg');
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
      assert.ok(!String(filled[0].option_text).startsWith('국산 고등어'), '채운 줄은 새 이름으로 안 바뀐다 ' + filled[0].option_text);
      assert.deepEqual(ls.filter(x => !x.filled).map(x => x.option_text).sort(),
        ['국산 고등어 · 1kg', '국산 고등어 · 2kg', '국산 고등어 · 2kg', '고등어 2팩 세트 · 기본', '고등어 2팩 세트 · 기본', '고등어 2팩 세트 · 선물', '고등어 2팩 세트 · 선물'].sort());
      const pr2 = await purchase(A, '1kg');
      assert.equal(pr2.w.ok, true, JSON.stringify(pr2.w)); assert.ok(Number(pr2.row.seq) <= 2, '새 이름 주문 = 남은 고등어 1kg 빈 줄 seq=' + (pr2.row && pr2.row.seq)); assert.equal(await A.rows(), 8);
    });
    console.log(`productRenameSlotsNativePg: ${passed} passed`);
  } finally {
    if (H) await H.close().catch(() => {});
    if (dbPool) await dbPool.end().catch(() => {});
    await cluster.close().catch(() => {});
    fs.rmSync(cluster.dir, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
