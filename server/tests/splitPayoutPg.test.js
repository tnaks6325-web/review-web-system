/**
 * splitPayoutPg.test.js — 결정 291 「제품비 업체 · 리뷰비 우리」 · **진짜 PG16** 끝까지 검증
 * 실행: PGTEST_URL=postgres://... node tests/splitPayoutPg.test.js   (★ 마이그레이션된 **복사본** DB 에서만 — 표를 지우지는 않지만 행을 넣는다)
 *
 * 스텁으로 못 잡는 것만 본다:
 *   ① 대상 SQL 이 split 작업에서만 "리뷰 제출·입금 칸" 조건을 풀고, 아닌 작업은 그대로인지
 *   ② 금액 = 리뷰비만 · 회차에 제품비 0 박제 · 구매 전 줄은 보류
 *   ③ 결과 반영(리뷰비만) 뒤 리뷰어 "페이백 완료"(PAID)·입금 칸이 안 바뀌고 우리 원장만 남는지 + 다시 대상에 안 나오는지
 *   ④ 업체 입금일 기록이 우리 리뷰비 회차에 막히지 않고, 칸을 비워도 리뷰비 항목이 풀리지 않는지
 *   ⑤ 우리가 이미 제품비까지 보낸 줄은 split 에서도 대상 아님 · 업체 기록도 막힘
 *   ⑥ split → 우리 입금으로 바꾸면 원래 조건(리뷰 제출·제품비+리뷰비)으로 돌아오는지 · 확인 없이 끄면 유지
 */
'use strict';

if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀 (스텁 가드는 splitPayout.test.js)');
  process.exit(0);
}

const pool = require('../src/db/pool');
const ledger = require('../src/services/sheetlessLedger.service');
const pay = require('../src/services/payment.service');
const apply = require('../src/services/paymentApply.service');
const tb = require('../src/services/trackB.service');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const SHEET = 'wt_splittest000000001';
const TAB = '스플릿검증탭';
const GID = '900000101';
const CAMP = 'camp_splittest01';
const ADV = 'adv_splittest01';
const HEADERS = ['번호', '구매일자', '수취인', '연락처', '상품', '결제금액', '리뷰제출', '입금일'];
// seq, 이름, 연락처, 결제금액, 리뷰
const ROWS = [
  [3, '가리뷰', '010-1000-0003', '5980', ''],              // 구매 · 리뷰 전 → 리뷰비 대상(1,000)
  [4, '나리뷰', '010-1000-0004', '5980', 'https://r/4'],   // 구매 · 리뷰 끝 → 리뷰비 대상
  [5, '다리뷰', '010-1000-0005', '', ''],                  // 구매 전 → not_purchased
  [6, '라리뷰', '010-1000-0006', '5980', 'https://r/6'],   // 우리가 이미 제품비 보냄 → 대상 아님
];
const key = seq => `${SHEET}||${TAB}||${seq}`;

async function cleanup() {
  for (const t of ['payment_records', 'review_index', 'campaign_participants', 'raw_sheet_tabs', 'index_master', 'participant_edits']) {
    await pool.query(`DELETE FROM ${t} WHERE sheet_id=$1`, [SHEET]).catch(() => {});
  }
  await pool.query(`DELETE FROM payment_batch_items WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM payment_batches WHERE created_by='split-test'`);
  await pool.query(`DELETE FROM recruit_campaigns WHERE id=$1`, [CAMP]);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM advertiser_campaigns WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM advertisers WHERE id=$1`, [ADV]);
  await pool.query(`DELETE FROM reviewers WHERE phone LIKE '010-1000-000%'`);
}

async function seed() {
  await cleanup();
  await pool.query(
    `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless, deposit_name)
     VALUES ($1,$2,$3,'스플릿검증',TRUE,'인애드리뷰')`, [SHEET, TAB, GID]);
  await pool.query(
    `INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name, headers, detected_headers, mirrored_at)
     VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,NOW())`, [SHEET, GID, TAB, JSON.stringify(HEADERS)]);
  await pool.query(
    `INSERT INTO recruit_campaigns (id, title, linked_sheet_id, linked_tab_name, linked_tab_gid, transfer_bank, review_fee, transfer_memo, status, created_at)
     VALUES ($1,'스플릿 공고',$2,$3,$4,'split_kbank',1000,'인애드리뷰','active',NOW())`, [CAMP, SHEET, TAB, GID]);
  await pool.query(`INSERT INTO advertisers (id, name) VALUES ($1,'스플릿업체')`, [ADV]);
  await pool.query(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id) VALUES ($1,$2)`, [ADV, SHEET]);
  for (const [seq, name, phone, price, review] of ROWS) {
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, source, active, phone8, recipient_name, identity_key)
       VALUES ($1,$2,$3,$4::jsonb,'worktable',TRUE,$5,$6,$7)`,
      [SHEET, TAB, seq, JSON.stringify({
        '번호': String(seq - 2), '구매일자': '10/20', '수취인': name, '연락처': phone, '상품': '핫팩',
        '결제금액': price, '리뷰제출': review, '입금일': '',
      }), phone.replace(/\D/g, '').slice(-8), name, 'split:' + seq]);
    await pool.query(
      `INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder)
       VALUES ($1,$2,'국민은행',$3,$1)`, [name, phone, '1234567890' + seq]);
  }
  await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB, columns: HEADERS });
  // ⑤ 재료 — 라리뷰(6)는 split 로 바꾸기 전에 우리가 제품비까지 보낸 줄
  const { rows: [b] } = await pool.query(
    `INSERT INTO payment_batches (bank, created_by, status) VALUES ('kbank','split-test','applied') RETURNING id`);
  await pool.query(
    `INSERT INTO payment_batch_items (batch_id, sheet_id, tab_name, row_index, reviewer_name, phone8, bank_name, bank_account, account_holder,
       product_price, review_fee, amount, status, paid_at)
     VALUES ($1,$2,$3,6,'라리뷰','10000006','국민은행','12345678906','라리뷰',5980,0,5980,'paid',NOW())`, [b.id, SHEET, TAB]);
}

async function targets(opts = {}) {
  const out = await pay.listPaymentTargets({ includeFinished: true, sheetId: SHEET, tabName: TAB, ...opts });
  return { out, by: new Map(out.items.map(it => [key(it.rowIndex), it])) };
}

(async () => {
  try {
    await seed();
    const { rows: ri } = await pool.query(`SELECT row_index, is_submitted, phone8 FROM review_index WHERE sheet_id=$1 ORDER BY row_index`, [SHEET]);
    ok('재료: 장부 4줄 생성', ri.length === 4, ri);

    console.log('\n[1] 대상 — 제품비 업체 · 리뷰비 우리');
    let { out, by } = await targets();
    const a = by.get(key(3)), n = by.get(key(4)), d = by.get(key(5));
    ok('리뷰 전 줄(가)도 대상 · 금액 = 리뷰비 1,000', a && a.payable && a.amount === 1000 && a.payoutMode === 'split', a && { p: a.payable, amt: a.amount, iss: a.issues });
    ok('리뷰 끝 줄(나) 금액 = 1,000 · 은행 = 케이뱅크(split 값에서)', n && n.amount === 1000 && n.bank === 'kbank' && n.bankSource === 'campaign');
    ok('구매 전 줄(다) = not_purchased 로 보류', d && !d.payable && d.issues.includes('not_purchased'), d && d.issues);
    ok('⑤ 이미 제품비 보낸 줄(라)은 대상 아님', !by.has(key(6)));
    ok('작업별 진행 = 대상 2 · 구매 전 1', out.splitWorks.length === 1 && out.splitWorks[0].payable === 2 && out.splitWorks[0].notPurchased === 1, out.splitWorks);

    console.log('\n[1b] 후보 SQL — 공고 코드값(split_kbank)을 실제로 알아본다(템플릿 \\s 함정 회귀)');
    const keys = await pay.__splitCandidateKeysForTest();
    ok('★ 공고 값 split_kbank 작업이 후보에 든다', keys.includes(`${SHEET}||${TAB}`), keys);

    console.log('\n[2] 회차 — 화면이 본 입금 방식으로만 · 제품비 0 박제');
    const noMode = await pay.createBatch({ bank: 'kbank', by: 'split-test',
      rows: [{ sheetId: SHEET, tabName: TAB, rowIndex: 3, payoutFp: a.payoutFp }] });
    ok('★ 입금 방식을 모르는 옛 화면 요청은 split 건을 담지 않는다', noMode.ok === false && noMode.skipped.some(s => s.reason === 'payout_mode_changed'), noMode);
    const bad = await pay.createBatch({ bank: 'kbank', by: 'split-test',
      rows: [{ sheetId: SHEET, tabName: TAB, rowIndex: 3, payoutFp: a.payoutFp, payoutMode: 'ours' }] });
    ok('화면이 본 방식(ours)과 지금(split)이 다르면 회차를 만들지 않는다', bad.ok === false && bad.skipped.some(s => s.reason === 'payout_mode_changed'));
    const made = await pay.createBatch({ bank: 'kbank', by: 'split-test',
      rows: [3, 4].map(seq => ({ sheetId: SHEET, tabName: TAB, rowIndex: seq, payoutFp: by.get(key(seq)).payoutFp, payoutMode: 'split' })) });
    ok('회차 생성 2건', made.ok && made.items.length === 2, made);
    const { rows: items } = await pool.query(
      `SELECT id, row_index, product_price, review_fee, amount FROM payment_batch_items WHERE batch_id=$1 ORDER BY row_index`, [made.batch.id]);
    ok('박제 = 제품비 0 · 리뷰비 1,000 · 금액 1,000', items.every(i => Number(i.product_price) === 0 && Number(i.review_fee) === 1000 && Number(i.amount) === 1000), items);
    ok('isFeeOnlyItem 이 박제 행을 리뷰비 전용으로 읽는다', items.every(i => pay.isFeeOnlyItem(i)));
    ({ by } = await targets());
    ok('회차에 담긴 줄은 목록에서 빠진다(이중 담기 방지)', !by.has(key(3)) && !by.has(key(4)));

    console.log('\n[3] 결과 반영(리뷰비만) — 페이백 완료 표시·입금 칸은 그대로, 원장만');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE payment_batch_items SET status='paid', paid_at=NOW() WHERE batch_id=$1`, [made.batch.id]);
      const n2 = await apply.recordDeposits(client, items.map(i => ({ sheetId: SHEET, tabName: TAB, rowIndex: i.row_index,
        reviewerName: 'x', amount: '1000', feeOnly: pay.isFeeOnlyItem(i) })), { by: 'split-test' });
      await client.query('COMMIT');
      ok('원장 기록 2건', n2 === 2);
    } finally { client.release(); }
    const board = await apply.markDepositCells(items.map(i => ({ sheetId: SHEET, tabName: TAB, rowIndex: i.row_index, stamp: '10/26', feeOnly: true })), { by: 'split-test' });
    ok('입금 칸 쓰기는 건너뛰되 "처리됨"으로 센다(미기록 경고 없음)', board.recorded === 2 && board.failed === 0 && board.skipped === 0, board);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
    const { rows: st } = await pool.query(
      `SELECT row_index, is_submitted2, row_json->>'입금일' AS paid FROM review_index WHERE sheet_id=$1 AND row_index IN (3,4) ORDER BY row_index`, [SHEET]);
    ok('★ 리뷰어 "페이백 완료"(PAID) 표시 안 됨 · 입금 칸 빈 칸', st.every(r => r.is_submitted2 !== 'PAID' && !r.paid), st);
    const { rows: pr } = await pool.query(`SELECT row_index, amount FROM payment_records WHERE sheet_id=$1 ORDER BY row_index`, [SHEET]);
    ok('우리 원장 = 1,000 × 2', pr.length === 2 && pr.every(r => String(r.amount) === '1000'), pr);
    // 회차 항목을 지운다고 가정해도(취소 등) 원장이 다시 잠근다
    ({ by } = await targets());
    ok('리뷰비 받은 줄은 다시 대상에 안 나온다', !by.has(key(3)) && !by.has(key(4)));

    console.log('\n[4] 업체 제품비 입금일 기록 — 우리 리뷰비 회차와 서로 막지 않는다');
    const { rows: [p3] } = await pool.query(`SELECT id FROM campaign_participants WHERE sheet_id=$1 AND seq=4`, [SHEET]);
    const rec = await tb.setWorkdeskDepositDate({ sheetId: SHEET, tabName: TAB, rowId: p3.id, date: '2026-10-26',
      by: `업체#${ADV}:스플릿업체`, advertiser: true, advertiserId: ADV });
    ok('★ 리뷰비 회차가 paid 여도 업체가 제품비 입금일을 적는다(our_payout 아님)', rec.ok === true, rec);
    let { rows: [r4] } = await pool.query(`SELECT is_submitted2, row_json->>'입금일' AS paid FROM review_index WHERE sheet_id=$1 AND row_index=4`, [SHEET]);
    ok('업체 기록 = 리뷰어 페이백 완료(PAID) + 입금 칸 날짜', r4 && r4.is_submitted2 === 'PAID' && /10\/26/.test(r4.paid), r4);
    const clr = await tb.setWorkdeskDepositDate({ sheetId: SHEET, tabName: TAB, rowId: p3.id, date: '',
      by: `업체#${ADV}:스플릿업체`, advertiser: true, advertiserId: ADV });
    const { rows: [it4] } = await pool.query(`SELECT status FROM payment_batch_items WHERE batch_id=$1 AND row_index=4`, [made.batch.id]);
    ok('★ 칸을 비워도 리뷰비 항목은 풀리지 않는다(재지급 방지)', clr.ok === true && it4.status === 'paid' && !clr.releasedBatchItems, { clr, it4 });
    const { rows: [p6] } = await pool.query(`SELECT id FROM campaign_participants WHERE sheet_id=$1 AND seq=6`, [SHEET]);
    const rec6 = await tb.setWorkdeskDepositDate({ sheetId: SHEET, tabName: TAB, rowId: p6.id, date: '2026-10-26',
      by: `업체#${ADV}:스플릿업체`, advertiser: true, advertiserId: ADV });
    ok('⑤ 우리가 제품비까지 보낸 줄은 업체가 기록 못 한다(our_payout)', rec6.ok === false && rec6.error === 'our_payout', rec6);

    console.log('\n[5] 업체가 먼저 제품비를 적은 줄도 리뷰비는 받는다');
    await pool.query(`UPDATE campaign_participants SET row_json = row_json || '{"결제금액":"5980"}'::jsonb WHERE sheet_id=$1 AND seq=5`, [SHEET]);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
    const { rows: [p5] } = await pool.query(`SELECT id FROM campaign_participants WHERE sheet_id=$1 AND seq=5`, [SHEET]);
    await pool.query(`UPDATE campaign_participants SET row_json = row_json || '{"리뷰제출":"https://r/5"}'::jsonb WHERE id=$1`, [p5.id]);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
    const rec5 = await tb.setWorkdeskDepositDate({ sheetId: SHEET, tabName: TAB, rowId: p5.id, date: '2026-10-25',
      by: `업체#${ADV}:스플릿업체`, advertiser: true, advertiserId: ADV });
    ok('업체 기록 성공(다)', rec5.ok === true, rec5);
    ({ by } = await targets());
    const d2 = by.get(key(5));
    ok('★ 입금 칸에 업체 날짜가 있어도 리뷰비 1,000 대상', d2 && d2.payable && d2.amount === 1000, d2 && d2.issues);
    const made2 = await pay.createBatch({ bank: 'kbank', by: 'split-test',
      rows: [{ sheetId: SHEET, tabName: TAB, rowIndex: 5, payoutFp: d2.payoutFp, payoutMode: 'split' }] });
    ok('★ 회차 재확인이 업체 날짜를 already_paid 로 오인하지 않는다', made2.ok && made2.items.length === 1, made2);

    console.log('\n[5b] 우리 직원이 적은 입금일(원장 없이 우리가 보낸 돈)은 split 에서도 "이미 입금"');
    await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, source, active, phone8, recipient_name, identity_key)
       VALUES ($1,$2,7,$3::jsonb,'worktable',TRUE,'10000007','마리뷰','split:7')`, [SHEET, TAB, JSON.stringify({ '번호': '5', '구매일자': '10/20', '수취인': '마리뷰',
         '연락처': '010-1000-0007', '상품': '핫팩', '결제금액': '5980', '리뷰제출': 'https://r/7', '입금일': '' })]);
    await pool.query(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder) VALUES ('마리뷰','010-1000-0007','국민은행','123456789077','마리뷰')`);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
    const { rows: [p7] } = await pool.query(`SELECT id FROM campaign_participants WHERE sheet_id=$1 AND seq=7`, [SHEET]);
    const staff = await tb.setWorkdeskDepositDate({ sheetId: SHEET, tabName: TAB, rowId: p7.id, date: '2026-10-24', by: '직원김' });
    ok('직원 입금수정 성공', staff.ok === true, staff);
    ({ by } = await targets());
    ok('★ 직원이 적은 날짜가 있는 줄은 리뷰비 대상 아님(이중 지급 방지)', !by.has(key(7)));

    console.log('\n[5c] 업체가 자기 기록을 비워도 리뷰비 원장 잠금은 그대로');
    const clr5 = await tb.setWorkdeskDepositDate({ sheetId: SHEET, tabName: TAB, rowId: p3.id, date: '',
      by: `업체#${ADV}:스플릿업체`, advertiser: true, advertiserId: ADV });
    await pool.query(`UPDATE payment_batch_items SET status='cancelled' WHERE batch_id=$1 AND row_index=4`, [made.batch.id]);
    ({ by } = await targets());
    ok('★ 회차 항목이 없어도(원장만) 업체 비우기 뒤 리뷰비 재지급 안 됨', clr5.ok && !by.has(key(4)), { clr5, has: by.has(key(4)) });
    await pool.query(`UPDATE payment_batch_items SET status='paid' WHERE batch_id=$1 AND row_index=4`, [made.batch.id]);

    console.log('\n[5d] 업체입금 ↔ 제품비 업체 직접 전환 막기');
    const toAdv = await pay.saveTransferSetting({ sheetId: SHEET, tabName: TAB, campaignId: CAMP, bank: 'advertiser' }).catch(e => e);
    ok('★ 리뷰비를 이미 보낸 줄이 있으면 업체입금으로 못 바꾼다', toAdv && toAdv.code === 'fee_paid', toAdv && (toAdv.code || toAdv));

    console.log('\n[6] 우리 입금으로 되돌리기');
    const kept = await pay.saveTransferSetting({ sheetId: SHEET, tabName: TAB, campaignId: CAMP, bank: 'kbank' });
    let { rows: [c1] } = await pool.query(`SELECT transfer_bank FROM recruit_campaigns WHERE id=$1`, [CAMP]);
    ok('확인 표시 없이 끄면 그대로 둔다(제품비 업체 유지)', kept.transferBankKept && c1.transfer_bank === 'split_kbank', { kept, c1 });
    await pay.saveTransferSetting({ sheetId: SHEET, tabName: TAB, campaignId: CAMP, bank: 'kbank', disableAck: true });
    ({ rows: [c1] } = await pool.query(`SELECT transfer_bank FROM recruit_campaigns WHERE id=$1`, [CAMP]));
    ok('확인하면 케이뱅크(우리 입금)로', c1.transfer_bank === 'kbank');
    ({ out, by } = await targets());
    ok('되돌린 뒤에는 리뷰비만 받은 줄도 잠겨 있다(리뷰비 원장)', !by.has(key(3)) && !by.has(key(4)));
    ok('되돌린 뒤 split 진행 안내는 없다', out.splitWorks.length === 0);

    console.log('\n[7] 판정 단위');
    ok('payoutModeFrom: 공고 은행 명시 > 탭 split', pay.payoutModeFrom('kbank', '제품비업체·리뷰비하나은행').mode === 'ours');
    ok('payoutModeFrom: 공고 자동 + 탭 split 라벨 = split(하나)', (m => m.mode === 'split' && m.bank === 'hana' && m.source === 'tab')(pay.payoutModeFrom(null, '제품비업체·리뷰비하나은행')));
    ok('normalizeBankChoice 는 split 값을 은행으로 읽지 않는다', pay.normalizeBankChoice('split_kbank') === null && pay.normalizeBankChoice('제품비업체·리뷰비케이뱅크') === null);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
