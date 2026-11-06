'use strict';
/** Preservation tests, NOT the home-route feature's RED/GREEN tests.
 * Run with the pure-test guard, NODE_ENV=test, TZ=Asia/Seoul and existing
 * NODE_PATH containing @electric-sql/pglite and @e965/xlsx. No real DB/HTTP.
 * Actual service sources run in VM modules: all financial/proof SQL is PGlite.
 * Only board writes/verification, ledger rebuild and CS delivery are fakes.
 * Unused payment.service dependencies are fail-closed, not production-loaded.
 * Single connection; transactions hold a JS mutex through release(). This is
 * NOT multi-connection PostgreSQL concurrency/advisory-lock verification.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const XLSX = require('@e965/xlsx');
const root = path.resolve(__dirname, '..');
const { parseResultAoa } = require('../src/utils/paymentResultParse');
const sqlSeen = new Set();
let advisoryCalls = 0, boardFailure = false, boardCalls = 0, noticeCalls = 0;
const forbidden = new Proxy({}, { get(_o, k) { return () => { throw new Error(`Unused external dependency invoked: ${String(k)}`); }; } });
const logger = { warn() {}, info() {}, error() {}, debug() {} };
function sourceModule(name, overrides = {}, transform = x => x) {
  const filename = path.join(root, 'src/services', name + '.service.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const req = id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === '../utils/logger') return { logger };
    if (id === '../db/pool') throw new Error('Real pool import forbidden');
    return realRequire(id);
  };
  vm.runInNewContext(transform(fs.readFileSync(filename, 'utf8')), {
    module, exports: module.exports, require: req, Buffer, console, process,
    Date, Intl, setTimeout, clearTimeout,
  }, { filename });
  return module.exports;
}
function tableSql(file, table) {
  const text = fs.readFileSync(path.join(root, 'migrations', file), 'utf8');
  const match = text.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
  assert.ok(match, `migration owns ${table}`);
  return match[0];
}
async function schema(db) {
  // Project only referenced parent tables from 001; recruit_campaigns' TEXT
  // parent identity is the FK contract documented by 086/018, no fake columns.
  await db.exec('CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY)');
  for (const table of ['tab_configs', 'review_index', 'payment_records'])
    await db.exec(tableSql('001_create_tables.sql', table));
  // Exact additive per-tab schema-version statement from migration 137.
  const version = fs.readFileSync(path.join(root, 'migrations/137_workboard_status_column_bindings.sql'), 'utf8');
  const alter = version.match(/ALTER TABLE tab_configs[\s\S]*?;/);
  assert.ok(alter); await db.exec(alter[0]);
  for (const name of ['086_payment_batches.sql', '100_payment_result_apply.sql',
    '109_payment_result_file_archive.sql', '110_payment_batch_board_write.sql',
    '117_manual_811_transfer_ledger.sql', '119_payment_account_mismatch_reconciliations.sql',
    '122_payment_mismatch_reconciliation_upload_scope.sql', '150_payment_amount_mismatch_reconciliations.sql',
    '212_payment_item_qna.sql']) await db.exec(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
  // Exact CREATE statements; skip unrelated tables and optional pgcrypto
  // extension (gen_random_uuid is built in), not any payment constraints.
  await db.exec(tableSql('124_unconfirmed_transfer_reviews.sql', 'unconfirmed_transfer_reviews'));
  await db.exec(tableSql('208_external_work_transfers.sql', 'external_work_transfers'));
}
function adapter(db) {
  let tail = Promise.resolve();
  const acquire = async () => { let unlock; const next = new Promise(r => { unlock = r; }); const prev = tail; tail = next; await prev; return unlock; };
  const run = async (sql, params = []) => {
    sqlSeen.add(String(sql).replace(/\s+/g, ' ').trim());
    // PGlite lacks advisory locks. Only this exact statement is intercepted;
    // the mutex protects whole transactions, without claiming PG lock proof.
    if (sql === 'SELECT pg_advisory_xact_lock(hashtext($1))') { advisoryCalls++; return { rows: [], rowCount: 1 }; }
    const out = await db.query(sql, params);
    return { ...out, rowCount: out.affectedRows ?? out.rows.length };
  };
  return {
    query: async (sql, params) => { const unlock = await acquire(); try { return await run(sql, params); } finally { unlock(); } },
    connect: async () => { const unlock = await acquire(); let released = false; return { query: run, release() { assert.equal(released, false); released = true; unlock(); } }; },
  };
}
function services(pool, mutate = false) {
  const paymentFile = path.join(root, 'src/services/payment.service.js');
  const ids = [...fs.readFileSync(paymentFile, 'utf8').matchAll(/require\('([^']+)'\)/g)].map(x => x[1]);
  const paymentDeps = Object.fromEntries(ids.map(id => [id, forbidden]));
  paymentDeps['crypto'] = require('node:crypto'); paymentDeps['../db/pool'] = pool;
  paymentDeps['../utils/logger'] = { logger };
  const payment = sourceModule('payment', paymentDeps);
  const apply = sourceModule('paymentApply', {}, text => {
    if (!mutate) return text;
    const guard = "AND is_submitted2 IS DISTINCT FROM 'PAID'";
    assert.equal(text.split(guard).length, 2, 'exact mutation target once');
    return text.replace(guard, '');
  });
  const fakeApply = { ...apply,
    async markDepositCells(items) { boardCalls += items.length; return { recorded: boardFailure ? 0 : items.length, failed: boardFailure ? items.length : 0, skipped: 0, queued: 0 }; },
    async verifyDepositCells(items) { return { verified: boardFailure ? 0 : items.length, missing: 0 }; },
  };
  const external = sourceModule('paymentExternalWork'); external.__setPoolForTest(pool);
  const result = sourceModule('paymentResult', {
    './paymentApply.service': fakeApply,
    './payment.service': payment,
    './paymentExternalWork.service': external,
    './sheetlessLedger.service': { rebuildLedgers: async () => { throw new Error('Unexpected ledger rebuild'); } },
    '../utils/sheetlessScope': { isSheetless: async () => false },
    './csBridge.service': { postAdminNotice: async () => { noticeCalls++; return true; } },
  });
  result.__setPoolForTest(pool);
  return { result, apply };
}
function bankFile(failed = false, unknown = false) {
  const date = new Date().toISOString().slice(0, 10);
  const aoa = [['등록일자', '이체처리(예정)일', '입금계좌', '이체금액', '수수료', '받는분', '받는통장 표시', '내통장 표시', '처리상태']];
  for (let i = 1; i <= (unknown ? 3 : 2); i++) aoa.push([date, `${date} 12:26:09`, `하나은행 10000000${i}`, '24900', '0', `가상${i}`, '가상입금', '', failed && i === 2 ? '오류' : '처리완료']);
  const parsed = parseResultAoa(aoa, { expectBank: 'hana' }); assert.ok(parsed.ok); assert.equal(parsed.rows.length, unknown ? 3 : 2);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'fake');
  return { fileName: 'fake-result.xlsx', base64: XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), parsed };
}
async function fixture(pool, count = 3) {
  await pool.query('TRUNCATE payment_batches, payment_records, review_index, tab_configs CASCADE');
  const { rows: [b] } = await pool.query("INSERT INTO payment_batches(bank,created_at) VALUES ('hana', NOW()-INTERVAL '1 day') RETURNING id");
  await pool.query("INSERT INTO tab_configs(sheet_id,tab_name,workboard_schema_version) VALUES ('FAKE','FAKE',1)");
  for (let i = 1; i <= count; i++) {
    await pool.query("INSERT INTO payment_batch_items(batch_id,sheet_id,tab_name,row_index,reviewer_name,phone8,bank_account,amount,product_price) VALUES ($1,'FAKE','FAKE',$2,'가상','00000000',$3,24900,24900)", [b.id, i, `10000000${i}`]);
    await pool.query("INSERT INTO review_index(sheet_id,tab_name,row_index,reviewer_name,is_submitted) VALUES ('FAKE','FAKE',$1,'가상',true)", [i]);
  }
  return b.id;
}
const rows = async (pool, sql, params) => (await pool.query(sql, params)).rows;
const countRecords = async pool => (await rows(pool, 'SELECT COUNT(*)::int AS n FROM payment_records'))[0].n;
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
(async () => {
  const db = new PGlite();
  try {
    await schema(db); const pool = adapter(db); const { result, apply } = services(pool);
    if (process.argv.includes('--mutant-probe')) {
      await fixture(pool,1);
      const mutant=services(pool,true).apply;
      const item={sheetId:'FAKE',tabName:'FAKE',rowIndex:1,reviewerName:'가상',amount:'24900'};
      const c=await pool.connect();
      try { await c.query('BEGIN'); await mutant.recordDeposits(c,[item]); await mutant.recordDeposits(c,[item]); await c.query('COMMIT'); } finally { c.release(); }
      const n=await countRecords(pool);
      console.log(`MUTANT persisted records=${n}`);
      assert.equal(n,1,'same paid replay must add zero ledger records');
      throw new Error('Mutant unexpectedly survived');
    }
    const file = bankFile(true);
    await check('real find -> auto apply; failure + absent both failed; replay adds zero and keeps paid locks', async () => {
      const id = await fixture(pool); const found = await result.findBatchForResultFile(file); assert.equal(found.batchId, id); assert.equal(found.pending, 3);
      const out = await result.autoApplyResultFile({ ...file, batchId: found.batchId, by: 'fake', notifyFailed: false });
      assert.equal(out.autoApplied, true); assert.equal(out.applied, 1); assert.equal(out.failed, 2); assert.equal(out.notInFile, 1);
      const before = await rows(pool, 'SELECT row_index,status,paid_at,result_status,fail_reason FROM payment_batch_items ORDER BY row_index');
      assert.deepEqual(before.map(x => x.status), ['paid','failed','failed']); assert.equal(before[2].result_status, '결과 파일에 없음');
      assert.equal(await countRecords(pool), 1);
      assert.equal((await rows(pool, 'SELECT is_submitted2 FROM review_index WHERE row_index=1'))[0].is_submitted2, 'PAID');
      assert.equal((await result.findBatchForResultFile(file)).pending, 0);
      const retry = await result.autoApplyResultFile({ ...file, batchId: (await result.findBatchForResultFile(file)).batchId, notifyFailed: false });
      assert.equal(retry.autoApplied, false); assert.ok(retry.autoApply.blockers.includes('no_pending_items')); assert.equal(await countRecords(pool), 1);
      assert.deepEqual(await rows(pool, 'SELECT row_index,status,paid_at,result_status,fail_reason FROM payment_batch_items ORDER BY row_index'), before);
      await assert.rejects(pool.query("INSERT INTO payment_batch_items(batch_id,sheet_id,tab_name,row_index,amount) VALUES ($1,'FAKE','FAKE',1,24900)", [id]), e => e.code === '23505');
      await pool.query("INSERT INTO payment_batch_items(batch_id,sheet_id,tab_name,row_index,amount) VALUES ($1,'FAKE','FAKE',3,24900)", [id]);
      assert.equal((await rows(pool, "SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE status='pending'"))[0].n, 1);
    });
    await check('board-write failure reported after financial commit; no false rollback', async () => {
      const id = await fixture(pool, 2); boardFailure = true;
      try { const out = await result.autoApplyResultFile({ ...bankFile(), batchId: id, notifyFailed: false }); assert.equal(out.applied, 2); assert.equal(out.board.failed, 2); assert.equal(out.board.recorded, 0); assert.equal(await countRecords(pool), 2); assert.equal((await rows(pool, 'SELECT board_failed_count,status FROM payment_batches WHERE id=$1',[id]))[0].board_failed_count, 2); }
      finally { boardFailure = false; }
    });
    await check('unmatched outside row remains visible, not a fabricated auto-apply blocker', async () => {
      const id = await fixture(pool, 2); const out = await result.autoApplyResultFile({ ...bankFile(false,true), batchId:id, notifyFailed:false });
      assert.equal(out.autoApplied,true); assert.equal(out.applied,2); assert.equal(out.unmatchedResultCount,1); assert.equal(out.unmatchedResults.length,1); assert.equal(await countRecords(pool),2);
    });
    await check('history-only proof lock rejects before archive/payment writes', async () => {
      const id = await fixture(pool,2); await pool.query("UPDATE payment_batches SET historical_key='historical-fee:fake' WHERE id=$1",[id]);
      await assert.rejects(result.autoApplyResultFile({...bankFile(),batchId:id}), e=>e.code==='history_only');
      assert.equal(await countRecords(pool),0); assert.equal((await rows(pool,'SELECT COUNT(*)::int AS n FROM payment_result_uploads'))[0].n,0);
    });
    await check('reserved proof row blocks financial SQL; pending rows remain locked', async () => {
      const id = await fixture(pool,2); const f = bankFile();
      const sha = require('node:crypto').createHash('sha256').update(Buffer.from(f.base64,'base64')).digest('hex');
      await pool.query("INSERT INTO external_work_transfers(file_sha256,result_seq,work_name,amount) VALUES ($1,$2,'가상 외부작업',24900)",[sha,f.parsed.rows[0].seq]);
      await assert.rejects(result.autoApplyResultFile({...f,batchId:id,notifyFailed:false}),e=>e.code==='proof_already_used');
      assert.equal(await countRecords(pool),0);
      assert.deepEqual((await rows(pool,'SELECT status FROM payment_batch_items ORDER BY row_index')).map(x=>x.status),['pending','pending']);
      await assert.rejects(pool.query("INSERT INTO payment_batch_items(batch_id,sheet_id,tab_name,row_index,amount) VALUES ($1,'FAKE','FAKE',1,24900)",[id]),e=>e.code==='23505');
    });
    await check('later v2 review rejection rolls back earlier paid transitions and ledger insert', async () => {
      const id = await fixture(pool,2);
      await pool.query("UPDATE tab_configs SET workboard_schema_version=2");
      await pool.query('UPDATE review_index SET is_submitted=false WHERE row_index=2');
      const callsBefore=boardCalls;
      await assert.rejects(result.autoApplyResultFile({...bankFile(),batchId:id,notifyFailed:false}),e=>e.code==='payment_before_review');
      assert.equal(await countRecords(pool),0);
      assert.deepEqual((await rows(pool,'SELECT status FROM payment_batch_items ORDER BY row_index')).map(x=>x.status),['pending','pending']);
      assert.deepEqual((await rows(pool,'SELECT is_submitted2 FROM review_index ORDER BY row_index')).map(x=>x.is_submitted2),['NONE','NONE']);
      assert.equal(boardCalls,callsBefore);
    });
    await check('actual recordDeposits paid guard; memory-only mutation inserts duplicate and is detected', async () => {
      await fixture(pool,1); const item={sheetId:'FAKE',tabName:'FAKE',rowIndex:1,reviewerName:'가상',amount:'24900'};
      const client=await pool.connect();
      try { await client.query('BEGIN'); assert.equal(await apply.recordDeposits(client,[item]),1); assert.equal(await apply.recordDeposits(client,[item]),0); await client.query('COMMIT'); } finally {client.release();}
      assert.equal(await countRecords(pool),1);
      const probe = require('node:child_process').spawnSync(process.execPath,[__filename,'--mutant-probe'],{env:process.env,encoding:'utf8',timeout:30000});
      assert.equal(probe.error,undefined);
      assert.equal(probe.status,1,'separate guarded mutant process must fail');
      assert.match(probe.stdout,/MUTANT persisted records=2/);
      assert.match(probe.stderr,/same paid replay must add zero ledger records/);
      assert.match(probe.stderr,/AssertionError/);
      console.log('mutation killed: separate guarded process persisted 2 records; candidate persisted 1');
    });
    console.log(`${passed} cases passed; ${sqlSeen.size} distinct actual/advisory SQL statements; advisory interceptions=${advisoryCalls}; board fake item callbacks=${boardCalls}; notification callbacks=${noticeCalls}`);
    assert.equal(noticeCalls,0,'notifyFailed:false prevents external notifications');
    console.log('LIMIT: one PGlite connection + whole-transaction mutex; no multi-connection PostgreSQL race proof. Baseline preservation, not feature RED.');
  } finally { await db.close(); }
})().catch(e=>{ console.error(e.stack||e); process.exitCode=1; });
