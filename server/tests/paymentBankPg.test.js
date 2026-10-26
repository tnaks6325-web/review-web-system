/**
 * paymentBankPg.test.js — 결정 293 통장 자동 대조 · **진짜 PG16** 끝까지 검증
 * 실행: PGTEST_URL=postgres://... node tests/paymentBankPg.test.js   (★ 마이그레이션된 **복사본** DB 에서만 — 행을 넣는다)
 *
 *   ① 깨끗한 회차 → 결과 파일 없이 이체 완료 · 원장(payment_records) · 페이백 완료(PAID) · 회차 반영완료 · 기록 줄 source=bank
 *   ② 같은 확정을 다시 눌러도 바뀌는 것 0 · 기록 줄도 더 안 생김(이중 기록 0)
 *   ③ 실패가 섞인 회차(통장 부족 + 취소 반환) → 고르지 않으면 아무것도 안 바뀜 · 건수가 틀리면 거부 · 맞게 고르면 나머지 완료 + 고른 사람 실패
 *   ④ 다른 회차가 이미 완료한 묶음은 이 회차 것으로 보지 않는다
 *   ⑤ 회차 밖으로 나간 돈 = 묶음 − 회차 완료 − 취소 반환
 *   ⑥ 회차 목록에 '통장 확인'으로 보이고 실패 수가 부풀지 않는다
 */
'use strict';

if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀 (계산 규칙은 paymentBank.test.js)');
  process.exit(0);
}

const pool = require('../src/db/pool');
const ledger = require('../src/services/sheetlessLedger.service');
const pay = require('../src/services/payment.service');
const bank = require('../src/services/paymentBank.service');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const SHEET = 'wt_banktest000000001';
const TAB = '통장대조검증탭';
const GID = '900000201';
const HEADERS = ['번호', '구매일자', '수취인', '연락처', '상품', '결제금액', '리뷰제출', '입금일'];
const ROWS = [
  [3, '가통장', '010-2000-0003', '5980'],
  [4, '나통장', '010-2000-0004', '5980'],
  [5, '다통장', '010-2000-0005', '7900'],
  [6, '라통장', '010-2000-0006', '7900'],
  [7, '마통장', '010-2000-0007', '3000'],
];
const NOW = Date.now();
const MIN = 60 * 1000;
const iso = ms => new Date(ms).toISOString();

async function cleanup() {
  for (const t of ['payment_records', 'review_index', 'campaign_participants', 'raw_sheet_tabs', 'index_master', 'participant_edits']) {
    await pool.query(`DELETE FROM ${t} WHERE sheet_id=$1`, [SHEET]).catch(() => {});
  }
  await pool.query(`DELETE FROM payment_result_uploads WHERE batch_id IN (SELECT id FROM payment_batches WHERE created_by='bank-test')`);
  await pool.query(`DELETE FROM payment_batch_items WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM payment_batches WHERE created_by='bank-test'`);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM reviewers WHERE phone LIKE '010-2000-000%'`);
  await pool.query(`DELETE FROM payment_bank_rows WHERE bank='kbank' AND tid LIKE 'banktest-%'`);
}

async function seed() {
  await cleanup();
  await pool.query(
    `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless, deposit_name)
     VALUES ($1,$2,$3,'통장대조검증',TRUE,'인애드리뷰')`, [SHEET, TAB, GID]);
  await pool.query(
    `INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name, headers, detected_headers, mirrored_at)
     VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,NOW())`, [SHEET, GID, TAB, JSON.stringify(HEADERS)]);
  for (const [seq, name, phone, price] of ROWS) {
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, source, active, phone8, recipient_name, identity_key)
       VALUES ($1,$2,$3,$4::jsonb,'worktable',TRUE,$5,$6,$7)`,
      [SHEET, TAB, seq, JSON.stringify({ '번호': String(seq - 2), '구매일자': '10/20', '수취인': name, '연락처': phone, '상품': '핫팩',
        '결제금액': price, '리뷰제출': 'https://r/' + seq, '입금일': '' }), phone.replace(/\D/g, '').slice(-8), name, 'bank:' + seq]);
  }
  await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB, columns: HEADERS });
}

async function makeBatch(createdAt, rows) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO payment_batches (bank, created_by, status, created_at) VALUES ('kbank','bank-test','downloaded',$1) RETURNING id, seq`, [iso(createdAt)]);
  for (const seq of rows) {
    const r = ROWS.find(x => x[0] === seq);
    await pool.query(
      `INSERT INTO payment_batch_items (batch_id, sheet_id, tab_name, row_index, reviewer_name, phone8, bank_name, bank_account, account_holder,
         product_price, review_fee, amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,'국민은행',$7,$5,$8,0,$8,'pending')`,
      [b.id, SHEET, TAB, seq, r[1], r[2].replace(/\D/g, '').slice(-8), '9876543210' + seq, Number(r[3])]);
  }
  // 실제 회차(createBatch)처럼 건수·금액을 채운다
  await pool.query(`UPDATE payment_batches SET item_count = (SELECT COUNT(*) FROM payment_batch_items WHERE batch_id=$1),
    total_amount = (SELECT SUM(amount) FROM payment_batch_items WHERE batch_id=$1) WHERE id=$1`, [b.id]);
  return b;
}
async function bankRow(tid, at, amount, kind) {
  await pool.query(`INSERT INTO payment_bank_rows (bank, tid, traded_at, amount, kind) VALUES ('kbank',$1,$2,$3,$4)`,
    ['banktest-' + tid, iso(at), amount, kind]);
}
const items = async (batchId) => (await pool.query(
  `SELECT row_index, status, result_status, fail_reason, paid_at FROM payment_batch_items WHERE batch_id=$1 ORDER BY row_index`, [batchId])).rows;

(async () => {
  try {
    await seed();

    console.log('\n[1] 깨끗한 회차 — 결과 파일 없이 이체 완료');
    const T1 = NOW - 60 * MIN;
    const b1 = await makeBatch(T1 - 10 * MIN, [3, 4]);
    await bankRow('a1', T1, 5980, 'bulk_out');
    await bankRow('a2', T1 + 20 * 1000, 5980, 'bulk_out');
    await bankRow('a3', T1 + 30 * 1000, 12345, 'bulk_out');   // 회차 밖 줄(⑤)
    const rec1 = await bank.inspectBatch(b1.id);
    ok('대조 = clean · 묶음 3줄', rec1.state === 'clean' && rec1.cluster.rowCount === 3, { s: rec1.state, c: rec1.cluster });
    ok('회차 밖 1줄 12,345원', rec1.outside.count === 1 && rec1.outside.sum === 12345, rec1.outside);
    const c1 = await bank.confirmBatchFromBank({ batchId: b1.id, by: 'bank-test', notifyFailed: false });
    ok('확정 2건', c1.ok && c1.applied === 2 && c1.failed === 0 && c1.remaining === 0, c1);
    const it1 = await items(b1.id);
    ok('항목 paid · 결과 상태 = 통장 확인 · 이체 시각 = 통장 시각', it1.every(i => i.status === 'paid' && i.result_status === '통장 확인')
      && Math.abs(new Date(it1[0].paid_at).getTime() - T1) < 1000, it1);
    const { rows: pr } = await pool.query(`SELECT row_index FROM payment_records WHERE sheet_id=$1 ORDER BY row_index`, [SHEET]);
    ok('원장 기록 2건(결과 파일 반영과 같은 기록)', pr.length === 2 && pr[0].row_index === 3, pr);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
    const { rows: ri } = await pool.query(`SELECT row_index, is_submitted2 FROM review_index WHERE sheet_id=$1 AND row_index IN (3,4) ORDER BY row_index`, [SHEET]);
    ok('리뷰어 페이백 완료(PAID)', ri.every(r => r.is_submitted2 === 'PAID'), ri);
    const { rows: [bb1] } = await pool.query(`SELECT status FROM payment_batches WHERE id=$1`, [b1.id]);
    ok('회차 반영완료', bb1.status === 'applied', bb1);
    const { rows: up1 } = await pool.query(`SELECT file_format, applied, success_count, summary->>'source' AS src FROM payment_result_uploads WHERE batch_id=$1`, [b1.id]);
    ok('기록 줄 1개 · source=bank', up1.length === 1 && up1[0].file_format === 'bank' && up1[0].src === 'bank' && up1[0].success_count === 2, up1);

    console.log('\n[2] 다시 눌러도 이중 기록 0');
    let again;
    try { again = await bank.confirmBatchFromBank({ batchId: b1.id, by: 'bank-test', notifyFailed: false }); } catch (e) { again = { code: e.code }; }
    ok('이미 처리된 회차 = done 으로 거부', again.code === 'done', again);
    const { rows: up1b } = await pool.query(`SELECT 1 FROM payment_result_uploads WHERE batch_id=$1`, [b1.id]);
    ok('기록 줄 그대로 1개', up1b.length === 1);

    console.log('\n[3] 실패가 섞인 회차 — 통장 1건 출금 + 1건 취소 반환');
    const T2 = NOW - 40 * MIN;
    const b2 = await makeBatch(T2 - 5 * MIN, [5, 6, 7]);
    await bankRow('b1', T2, 7900, 'bulk_out');
    await bankRow('b2', T2 + 10 * 1000, 7900, 'bulk_out');
    await bankRow('b3', T2 + 15 * 1000, 3000, 'bulk_out');
    await bankRow('b4', T2 + 40 * 1000, 7900, 'refund_in');
    const rec2 = await bank.inspectBatch(b2.id);
    const a7900 = rec2.amounts && rec2.amounts.find(a => a.amount === 7900);
    ok('대조 = review · 7,900원 2명 중 1명 실패', rec2.state === 'review' && a7900 && a7900.failures === 1 && a7900.refunds === 1, rec2.amounts);
    ok('④ 1회차 묶음은 2회차 후보가 아니다(다른 묶음을 골랐다)', rec2.cluster.start === T2 - (T2 % 1000) || Math.abs(rec2.cluster.start - T2) < 1000, rec2.cluster);
    const c2a = await bank.confirmBatchFromBank({ batchId: b2.id, by: 'bank-test', notifyFailed: false });
    let it2 = await items(b2.id);
    ok('고르지 않고 확정 → 맞는 3,000원만 완료 · 7,900원 둘은 확인 필요로 남음', c2a.applied === 1 && c2a.remaining === 2
      && it2.find(i => i.row_index === 7).status === 'paid' && it2.filter(i => i.status === 'pending').length === 2, { c2a, it2 });
    const { rows: [bb2a] } = await pool.query(`SELECT status FROM payment_batches WHERE id=$1`, [b2.id]);
    ok('남은 건이 있으면 회차는 반영완료가 아니다', bb2a.status === 'downloaded', bb2a);
    let bad;
    try { bad = await bank.confirmBatchFromBank({ batchId: b2.id, by: 'bank-test', notifyFailed: false,
      failedItemIds: (await pool.query(`SELECT id FROM payment_batch_items WHERE batch_id=$1 AND amount=7900`, [b2.id])).rows.map(r => r.id) }); }
    catch (e) { bad = { code: e.code, message: e.message }; }
    ok('★ 통장 부족(1명)보다 많이 고르면 거부', bad.code === 'pick_count', bad);
    it2 = await items(b2.id);
    ok('거부 뒤 바뀐 것 0', it2.filter(i => i.status === 'pending').length === 2, it2);
    const { rows: [six] } = await pool.query(`SELECT id FROM payment_batch_items WHERE batch_id=$1 AND row_index=6`, [b2.id]);
    const c2b = await bank.confirmBatchFromBank({ batchId: b2.id, by: 'bank-test', notifyFailed: false, failedItemIds: [six.id] });
    it2 = await items(b2.id);
    ok('맞게 고르면 다는 완료 · 라는 실패', c2b.applied === 1 && c2b.failed === 1
      && it2.find(i => i.row_index === 5).status === 'paid' && it2.find(i => i.row_index === 6).status === 'failed'
      && /통장/.test(it2.find(i => i.row_index === 6).fail_reason), it2);
    const { rows: [bb2] } = await pool.query(`SELECT status FROM payment_batches WHERE id=$1`, [b2.id]);
    ok('다 정해지면 회차 반영완료', bb2.status === 'applied', bb2);
    const { rows: pr2 } = await pool.query(`SELECT row_index FROM payment_records WHERE sheet_id=$1 ORDER BY row_index`, [SHEET]);
    ok('원장 = 3·4·5·7(실패한 6 없음)', pr2.map(r => r.row_index).join(',') === '3,4,5,7', pr2);

    console.log('\n[5] 회차 밖으로 나간 돈');
    const ov = await bank.bankOverview();
    ok('회차 밖 = 12,345원 1건(취소 반환된 7,900원·회차 완료 건은 빠진다)', ov.outside.count === 1 && ov.outside.sum === 12345, ov.outside);

    console.log('\n[6] 회차 목록 표시');
    const list = await pay.listBatches(50);
    const v1 = list.find(x => x.id === b1.id), v2 = list.find(x => x.id === b2.id);
    ok('1회차 = 통장 확인 · 성공 2 · 실패 0', v1.resultSource === 'bank' && v1.resultSuccessCount === 2 && v1.resultFailedCount === 0, v1);
    ok('2회차 = 통장 확인 · 실패 1(부풀지 않음)', v2.resultSource === 'bank' && v2.failedCount === 1 && v2.resultFailedCount === 1, v2);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await cleanup().catch(() => {});
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
