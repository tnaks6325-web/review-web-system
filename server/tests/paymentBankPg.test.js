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
/* 결정 317 — 운영에서 케이뱅크는 결과 파일로만 완료(confirmBy 'file')·하나은행은 이름(confirmBy 'name')이다.
   [1]~[3]·[8]·[9] 는 금액 대조 엔진과 공용 기록 경로(_commitBatchOutcome) 회귀 — 이 테스트 안에서만 케이뱅크를 금액 모드로 돌린다.
   운영 규칙은 [10](케이뱅크 결과 파일만)·[11](하나은행 이름) 이 고정한다. */
const KBANK_CONFIRM = bank.BANKS.kbank.confirmBy;
bank.BANKS.kbank.confirmBy = 'amount';

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
  [8, '바통장', '010-2000-0008', '3000'],   // [7] 하나은행 회차
  [9, '사통장', '010-2000-0009', '4500'],   // [8] 자동 받기 — 빠진 사람이 있는 회차
  [10, '아통장', '010-2000-0001', '4500'],
  [11, '자통장', '010-2000-0002', '2500'],
  [12, '차통장', '010-2000-0012', '6000'],   // [9] 결과 파일 한 곳에 놓기(결정 309)
  [13, '카통장', '010-2000-0013', '6000'],
  [14, '타통장', '010-2000-0014', '6000'],   //   계좌 오류로 은행이 뺀 사람(결과 파일에 없음)
  [15, '파통장', '010-2000-0015', '2500'],
  [16, '하통장', '010-2000-0016', '9100'],
  [17, '거통장', '010-2000-0017', '9100'],
  [18, '너통장', '010-2000-0018', '3000'],   // [11] 하나은행 이름 — 받음
  [19, '더통장', '010-2000-0019', '3000'],   //   받음
  [20, '러통장', '010-2000-0020', '3000'],   //   계좌 오류로 빠짐(통장에 이름 없음) — 같은 금액의 리뷰웹 밖 줄이 대신 찍힘
  [21, '머통장', '010-2000-0021', '4100'],   // [10] 케이뱅크 결과 파일만
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
  await pool.query(`DELETE FROM payment_bank_rows WHERE bank IN ('kbank','hana') AND tid LIKE 'banktest-%'`);
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

async function makeBatch(createdAt, rows, bankId = 'kbank') {
  const { rows: [b] } = await pool.query(
    `INSERT INTO payment_batches (bank, created_by, status, created_at) VALUES ($2,'bank-test','downloaded',$1) RETURNING id, seq`, [iso(createdAt), bankId]);
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
async function bankRow(tid, at, amount, kind, bankId = 'kbank') {
  await pool.query(`INSERT INTO payment_bank_rows (bank, tid, traded_at, amount, kind) VALUES ($5,$1,$2,$3,$4)`,
    ['banktest-' + tid, iso(at), amount, kind, bankId]);
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
    await bankRow('a3', T1 - 20 * MIN, 12345, 'bulk_out');   // 회차 밖 줄(⑤) — 묶음과 떨어진 따로 출금(결정 317: 묶음 안에 섞이면 통장으로 정하지 않는다 → [10]·paymentBank 2f)
    const rec1 = await bank.inspectBatch(b1.id);
    ok('대조 = clean · 묶음 2줄 · 섞이지 않음', rec1.state === 'clean' && rec1.cluster.rowCount === 2 && !rec1.mixed, { s: rec1.state, c: rec1.cluster });
    ok('묶음 안 회차 밖 줄 0', rec1.outside.count === 0, rec1.outside);
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

    console.log('\n[7] 하나은행 회차 — 하나은행 통장과만 맞댄다(결정 303)');
    const T7 = NOW - 90 * MIN;
    const b7 = await makeBatch(T7 - 10 * MIN, [8], 'hana');
    await bankRow('k7', T7, 3000, 'bulk_out');            // 같은 시각 케이뱅크 3,000원 — 하나 회차와 섞이면 안 된다
    let rec7 = await bank.inspectBatch(b7.id);
    ok('케이뱅크 줄만 있으면 하나 회차는 못 찾음', rec7.state === 'not_found' && rec7.bank === 'hana', rec7.state);
    await bankRow('h7', T7, 3000, 'bulk_out', 'hana');
    rec7 = await bank.inspectBatch(b7.id);
    ok('결정 317 — 이름으로 맞추지 않은 하나 줄은 이 회차 것이 아니다(not_found)', rec7.state === 'not_found' && rec7.mode === 'name', rec7.state);
    const { rows: [i8] } = await pool.query(`SELECT id FROM payment_batch_items WHERE batch_id=$1`, [b7.id]);
    await pool.query(`UPDATE payment_bank_rows SET matched_item_id = $1 WHERE bank='hana' AND tid='banktest-h7'`, [i8.id]);
    rec7 = await bank.inspectBatch(b7.id);
    ok('받을 때 이름으로 맞춘 줄이면 clean', rec7.state === 'clean' && rec7.cluster.rowCount === 1, rec7.state);
    const c7 = await bank.confirmBatchFromBank({ batchId: b7.id, by: 'bank-test', notifyFailed: false });
    ok('하나 회차 확정 1건', c7.applied === 1 && c7.remaining === 0, c7);
    const { rows: up7 } = await pool.query(`SELECT bank, file_name FROM payment_result_uploads WHERE batch_id=$1`, [b7.id]);
    ok('기록 줄 = 하나은행 거래내역', up7.length === 1 && up7[0].bank === 'hana' && /하나은행 거래내역/.test(up7[0].file_name), up7);
    const ov7 = await bank.bankOverview();
    ok('개요 = 은행 두 줄(케이뱅크 먼저) · 맨 위 값은 케이뱅크(옛 화면)', ov7.banks.map(b => b.bank).join(',') === 'kbank,hana'
      && ov7.banks[1].settleMinutes === 30 && ov7.outside === ov7.banks[0].outside, ov7.banks.map(b => [b.bank, b.outside]));
    ok('케이뱅크 3,000원은 케이뱅크 기록 없이 나간 돈 · 하나 3,000원은 회차가 가져감', ov7.banks[0].outside.days.length >= 1
      && ov7.banks[1].outside.count === 0, ov7.banks.map(b => b.outside));

    console.log('\n[8] 자동 받기 — 다운로드 뒤 서버가 스스로 받고, 빠진 사람이 섞인 금액만 남긴다(결정 304)');
    const T8 = NOW - 30 * MIN;
    const b8 = await makeBatch(T8 - 5 * MIN, [9, 10, 11]);
    await pool.query(`UPDATE payment_batches SET last_downloaded_at = $2, download_count = 1 WHERE id = $1`, [b8.id, iso(T8 - 4 * MIN)]);
    await pool.query(`INSERT INTO payment_bank_sync (bank) VALUES ('kbank') ON CONFLICT (bank) DO NOTHING`);
    await pool.query(`UPDATE payment_bank_sync SET last_synced_at = NULL WHERE bank IN ('kbank','hana')`);
    const kst = ms => new Date(ms + 9 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
    const calls = [];
    bank.__setFetchForTest(async (url, init) => {
      calls.push(url + ' ' + ((init && init.body) || ''));
      if (url.endsWith('/api/bank/accounts')) return { status: 200, ok: true, json: async () => ({ accounts: [{ bankCode: '0089', accountNumber: '700' }, { bankCode: '0081', accountNumber: '402' }] }) };
      return { status: 200, ok: true, json: async () => ({ success: true, allPages: true, truncated: false, list: [
        { tradeDT: kst(T8), tradeAmt: 4500, tran_type: 'withdraw', remark1: '대량이체', remark3: '대량이체', tid: 'banktest-q1', balance: 1 },
        { tradeDT: kst(T8 + 10 * 1000), tradeAmt: 2500, tran_type: 'withdraw', remark1: '대량이체', remark3: '대량이체', tid: 'banktest-q2', balance: 1 },
      ] }) };
    });
    const env8 = { POPBILL_RELAY_URL: 'http://relay.test' };
    const a8 = await bank.autoSync({ now: NOW, env: env8 });
    ok('다운로드 30분 뒤 · 처음 = 케이뱅크만 받는다(하나은행 회차 없음)', a8.ran && a8.banks.join(',') === 'kbank'
      && calls.filter(c => /bank\/collect/.test(c)).length === 1 && /0089/.test(calls.find(c => /bank\/collect/.test(c))), { a8, calls });
    const auto8 = (a8.sync.autoConfirmed || []).find(x => x.batchId === b8.id);
    ok('빠진 사람이 있어도 맞는 2,500원은 자동 완료 · 4,500원 둘은 남김', auto8 && auto8.applied === 1 && auto8.remaining === 2, a8.sync.autoConfirmed);
    const it8 = await items(b8.id);
    ok('사·아 = 확인 필요(pending) · 자 = 이체 완료', it8.find(i => i.row_index === 11).status === 'paid'
      && it8.filter(i => i.status === 'pending').map(i => i.row_index).join(',') === '9,10', it8);
    const { rows: up8 } = await pool.query(`SELECT uploaded_by, success_count FROM payment_result_uploads WHERE batch_id=$1`, [b8.id]);
    ok('기록 줄 = 통장 자동확인(자동)', up8.length === 1 && /통장 자동확인\(자동\)/.test(up8[0].uploaded_by) && up8[0].success_count === 1, up8);
    calls.length = 0;
    await pool.query(`UPDATE payment_bank_sync SET last_synced_at = NULL WHERE bank = 'kbank'`);
    const a8b = await bank.autoSync({ now: NOW, env: env8 });
    ok('★ 한 번 확정한 회차는 더 받지 않는다(남은 건 사람이 고를 것뿐)', !a8b.ran && calls.length === 0, { a8b, calls });
    const rec8 = await bank.inspectBatch(b8.id);
    ok('남은 4,500원 = 통장 기준 1명 못 받음 → 뺀 사람 고르기', rec8.state === 'review'
      && rec8.amounts.find(x => x.amount === 4500).failures === 1, rec8.amounts);
    bank.__setFetchForTest(null);

    console.log('\n[9] 결과 파일 한 곳에 놓기 — 통장으로 먼저 일부 완료된 대량이체에 결과 파일(결정 309)');
    const result = require('../src/services/paymentResult.service');
    const XLSX = require('@e965/xlsx');
    const T9 = NOW - 50 * MIN;
    const b9 = await makeBatch(T9 - 5 * MIN, [12, 13, 14, 15, 16, 17]);
    await bankRow('r1', T9, 6000, 'bulk_out'); await bankRow('r2', T9 + 1000, 6000, 'bulk_out');
    await bankRow('r3', T9 + 2000, 2500, 'bulk_out');
    await bankRow('r4', T9 + 3000, 9100, 'bulk_out'); await bankRow('r5', T9 + 4000, 9100, 'bulk_out');
    const a9 = await bank.confirmBatchFromBank({ batchId: b9.id, by: 'bank-test', auto: true, notifyFailed: false });
    ok('통장 자동: 2,500원·9,100원 3명 완료 · 6,000원 셋은 확인 필요', a9.applied === 3 && a9.remaining === 3, a9);
    const acct = seq => '9876543210' + seq;
    const kstDot = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '.');
    const fileRow = (seq, amt) => ['', kstDot(T9 + 10 * 1000), `국민 ${acct(seq)}`, ROWS.find(x => x[0] === seq)[1], Number(amt).toLocaleString('en-US'), '0', '인애드리뷰', '이체완료'];
    const aoa = [[' ', '이체일시', '입금계좌', '예금주', '이체금액(원)', '수수료(원)', '받는분 통장표시', '처리결과'],
      fileRow(12, 6000), fileRow(13, 6000), fileRow(15, 2500), fileRow(16, 9100), fileRow(17, 9100)];   // 14 = 은행이 뺀 사람
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const found = await result.findBatchForResultFile({ fileName: 'kbank-result.xlsx', base64 });
    ok('대량이체를 고르지 않아도 이 대량이체를 찾는다', found.batchId === b9.id && found.bank === 'kbank' && found.matchedRows === 5 && found.pending === 3, found);
    const r9 = await result.autoApplyResultFile({ batchId: found.batchId, fileName: 'kbank-result.xlsx', base64, by: 'bank-test', notifyFailed: false });
    const it9 = await items(b9.id);
    const st = n => it9.find(i => i.row_index === n).status;
    ok('파일에 있는 6,000원 둘 = 이체 완료 · 파일에 없는 사람(계좌 오류) = 실패', r9.autoApplied === true && st(12) === 'paid' && st(13) === 'paid' && st(14) === 'failed', { r9: { autoApplied: r9.autoApplied, autoApply: r9.autoApply }, it9 });
    ok('통장으로 먼저 완료된 셋은 그대로(통장 확인)', [15, 16, 17].every(n => st(n) === 'paid')
      && it9.filter(i => [15, 16, 17].includes(i.row_index)).every(i => i.result_status === '통장 확인'), it9);
    const { rows: [bb9] } = await pool.query(`SELECT status FROM payment_batches WHERE id=$1`, [b9.id]);
    ok('다 정해지면 대량이체 반영완료', bb9.status === 'applied', bb9);
    const again9 = await result.findBatchForResultFile({ fileName: 'kbank-result.xlsx', base64 });
    ok('같은 파일을 또 놓으면 = 다 처리됨(pending 0)', again9.batchId === b9.id && again9.pending === 0, again9);
    const r9b = await result.autoApplyResultFile({ batchId: again9.batchId, fileName: 'kbank-result.xlsx', base64, by: 'bank-test', notifyFailed: false });
    const it9b = await items(b9.id);
    ok('다 처리된 대량이체에 다시 반영해도 바뀌는 것 0(같은 입구 · 반영 보류)', r9b.autoApplied !== true && JSON.stringify(it9b) === JSON.stringify(it9), { auto: r9b.autoApply });
    const oldAoa = aoa.map((r, k) => k ? [r[0], kstDot(T9 - 60 * MIN), ...r.slice(2)] : r);
    const wb2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(oldAoa), 'S');
    let old; try { old = await result.findBatchForResultFile({ fileName: 'old.xlsx', base64: XLSX.write(wb2, { type: 'base64', bookType: 'xlsx' }) }); } catch (e) { old = { code: e.code }; }
    ok('★ 대량이체를 만들기 전 시각의 이체 파일은 그 대량이체로 가지 않는다(no_batch)', old.code === 'no_batch', old);
    const { rows: pr9 } = await pool.query(`SELECT row_index FROM payment_records WHERE sheet_id=$1 AND row_index BETWEEN 12 AND 17 ORDER BY row_index`, [SHEET]);
    ok('원장 = 12·13·15·16·17(실패한 14 없음 · 두 번 기록 없음)', pr9.map(r => r.row_index).join(',') === '12,13,15,16,17', pr9);

    console.log('\n[10] 결정 317 — 케이뱅크는 통장으로 이체 완료를 적지 않는다(결과 파일만) · 30분 뒤 결과 파일 필요');
    bank.BANKS.kbank.confirmBy = KBANK_CONFIRM;
    ok('운영 설정 = 케이뱅크 file · 하나은행 name', bank.BANKS.kbank.confirmBy === 'file' && bank.BANKS.hana.confirmBy === 'name');
    const T10 = NOW - 20 * MIN;
    const b10 = await makeBatch(T10 - 5 * MIN, [21]);
    await bankRow('f1', T10, 4100, 'bulk_out');
    let rec10 = await bank.inspectBatch(b10.id);
    ok('통장에서 찾고 clean 이어도 fileOnly · 30분 전이면 결과 파일 필요 아님', rec10.state === 'clean' && rec10.fileOnly && !rec10.needFile, { s: rec10.state, f: rec10.fileOnly, n: rec10.needFile });
    rec10 = await bank.inspectBatch(b10.id, { now: T10 + 31 * MIN });
    ok('출금 30분 뒤 = 결과 파일 필요', rec10.needFile === true, rec10.needFile);
    let c10; try { c10 = await bank.confirmBatchFromBank({ batchId: b10.id, by: 'bank-test', notifyFailed: false }); } catch (e) { c10 = { code: e.code }; }
    ok('★ 통장으로 확정 거부(file_only) — 사람이 눌러도', c10.code === 'file_only', c10);
    await pool.query(`UPDATE payment_batches SET last_downloaded_at = $2 WHERE id = $1`, [b10.id, iso(T10 - 4 * MIN)]);
    await pool.query(`UPDATE payment_bank_sync SET last_synced_at = NULL WHERE bank IN ('kbank','hana')`);
    bank.__setFetchForTest(async (url) => url.endsWith('/api/bank/accounts')
      ? { status: 200, ok: true, json: async () => ({ accounts: [{ bankCode: '0089', accountNumber: '700' }, { bankCode: '0081', accountNumber: '402' }] }) }
      : { status: 200, ok: true, json: async () => ({ success: true, allPages: true, truncated: false, list: [] }) });
    const a10 = await bank.syncBank({ by: 'bank-test', force: true, env: { POPBILL_RELAY_URL: 'http://relay.test' }, banks: ['kbank'] });
    ok('★ 통장 받기는 되지만 자동 완료 0', a10.ok && !(a10.autoConfirmed || []).some(x => x.batchId === b10.id), a10.autoConfirmed);
    ok('항목은 그대로 처리 전', (await items(b10.id)).every(i => i.status === 'pending'));
    const ovb = (await bank.bankOverview({ env: { POPBILL_RELAY_URL: 'http://relay.test' } }));
    ok('개요 = 은행별 confirmBy · 대량이체 줄에 fileOnly', ovb.banks.find(b => b.bank === 'kbank').confirmBy === 'file'
      && ovb.batches.find(b => b.batchId === b10.id).fileOnly === true, ovb.banks.map(b => [b.bank, b.confirmBy]));

    console.log('\n[11] 결정 317 — 하나은행은 받는 사람 이름으로 맞춘다 · 리뷰웹 밖 같은 금액 줄 + 빠진 사람이 겹쳐도 잘못 적지 않는다');
    const T11 = NOW - 60 * MIN;
    const b11 = await makeBatch(T11 - 10 * MIN, [18, 19, 20], 'hana');
    const kst11 = ms => new Date(ms + 9 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
    bank.__setFetchForTest(async (url) => url.endsWith('/api/bank/accounts')
      ? { status: 200, ok: true, json: async () => ({ accounts: [{ bankCode: '0081', accountNumber: '402' }] }) }
      : { status: 200, ok: true, json: async () => ({ success: true, allPages: true, truncated: false, list: [
        { tradeDT: kst11(T11), tradeAmt: 3000, tran_type: 'withdraw', remark1: '너통장', remark3: '타행송금', tid: 'banktest-n1', balance: 1 },
        { tradeDT: kst11(T11), tradeAmt: 3000, tran_type: 'withdraw', remark1: '김바깥', remark3: '타행송금', tid: 'banktest-n2', balance: 1 },   // 리뷰웹 밖 작업
        { tradeDT: kst11(T11), tradeAmt: 3000, tran_type: 'withdraw', remark1: '더 통장', remark3: '타행송금', tid: 'banktest-n3', balance: 1 },
      ] }) });
    await pool.query(`UPDATE payment_bank_sync SET last_synced_at = NULL WHERE bank = 'hana'`);
    const a11 = await bank.syncBank({ by: 'bank-test', force: true, env: { POPBILL_RELAY_URL: 'http://relay.test' }, banks: ['hana'] });
    const auto11 = (a11.autoConfirmed || []).find(x => x.batchId === b11.id);
    ok('통장 3줄(같은 금액) 중 이름이 맞는 2명만 자동 완료 · 1명 남김', a11.ok && auto11 && auto11.applied === 2 && auto11.remaining === 1, a11.autoConfirmed);
    const it11 = await items(b11.id);
    const st11 = n => it11.find(i => i.row_index === n).status;
    ok('★ 빠진 사람(러)은 실패도 완료도 아닌 처리 전(확인 필요)', st11(18) === 'paid' && st11(19) === 'paid' && st11(20) === 'pending', it11);
    const { rows: m11 } = await pool.query(`SELECT tid, matched_item_id FROM payment_bank_rows WHERE bank='hana' AND tid LIKE 'banktest-n%' ORDER BY tid`);
    ok('맞춘 줄 2개 · 리뷰웹 밖 줄은 짝 없음', m11.filter(r => r.matched_item_id).length === 2 && !m11.find(r => r.tid === 'banktest-n2').matched_item_id, m11);
    const { rows: cols } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='payment_bank_rows'`);
    ok('★ 통장 줄 표에 이름 칸이 없다(결정 293 — 이름은 저장하지 않는다)', !cols.some(c => /name|holder|payee|memo|remark/.test(c.column_name)), cols.map(c => c.column_name));
    const rec11 = await bank.inspectBatch(b11.id);
    ok('남은 사람 = 확인 필요(review) · 회차 밖 1줄', rec11.state === 'review' && rec11.outside.count === 1 && rec11.unresolvedIds.length === 1, { s: rec11.state, o: rec11.outside });
    await pool.query(`UPDATE payment_bank_sync SET last_synced_at = NULL WHERE bank = 'hana'`);
    await bank.syncBank({ by: 'bank-test', force: true, env: { POPBILL_RELAY_URL: 'http://relay.test' }, banks: ['hana'] });
    const { rows: m11b } = await pool.query(`SELECT tid, matched_item_id FROM payment_bank_rows WHERE bank='hana' AND tid LIKE 'banktest-n%' ORDER BY tid`);
    ok('다시 받아도 짝이 바뀌지 않는다', JSON.stringify(m11b) === JSON.stringify(m11), m11b);
    let p11; try { p11 = await bank.confirmBatchFromBank({ batchId: b11.id, by: 'bank-test', notifyFailed: false, failedItemIds: [it11.find(i => i.row_index === 20) && (await pool.query(`SELECT id FROM payment_batch_items WHERE batch_id=$1 AND row_index=20`, [b11.id])).rows[0].id] }); } catch (e) { p11 = { code: e.code }; }
    ok('하나은행은 통장으로 실패를 고르지 않는다(bad_pick)', p11.code === 'bad_pick', p11);
    bank.__setFetchForTest(null);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    bank.BANKS.kbank.confirmBy = KBANK_CONFIRM;
    await cleanup().catch(() => {});
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
