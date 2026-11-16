/**
 * zeroPricePurchasePayoutPg.test.js — 결정 376 「0원 구매 · 리뷰비만」 · **진짜 PG16** 끝까지 검증
 * 실행: PGTEST_URL=postgres://... node tests/zeroPricePurchasePayoutPg.test.js   (★ 마이그레이션된 **복사본** DB 에서만 — 행을 넣는다)
 *
 * 스텁으로 못 잡는 것만 본다(판정 규칙·배선은 zeroPricePurchasePayout.test.js):
 *   [1] 대상 SQL + 실제 리뷰오더(work_orders)·공고 경유 주문·작업보드 표시값으로 0원 구매 줄만 리뷰비 대상 · 나머지 보류 그대로
 *       (빈칸·문자·음수 표기·리뷰 미제출·이미 회차·연결 주문 금액>0)
 *   [2] 같은 줄에서 리뷰오더 금액>0 · 리뷰오더 없음 · 제품비 업체(split) · 리뷰비 0 으로 바꾸면 종전 보류로 돌아간다
 *   [3] 회차 — 제품비 0 · 금액 = 리뷰비 · zero_price_purchase 박제 · 「리뷰비만」(JS·SQL) 판정에서 빠짐 · 두 번 담기 0
 *   [4] 케이뱅크 결과 파일 반영 → 원장 1,500 · 리뷰어 페이백 완료(PAID) · 작업표 입금일 칸 기록 · 다시 대상 아님
 *   [5] 하나은행 통장 자동확인(이름 대조) → 같은 결과(통장 확인 경로도 표시를 싣는다)
 */
'use strict';

if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀 (규칙·배선 가드는 zeroPricePurchasePayout.test.js)');
  process.exit(0);
}

const pool = require('../src/db/pool');
const ledger = require('../src/services/sheetlessLedger.service');
const pay = require('../src/services/payment.service');
const bank = require('../src/services/paymentBank.service');
const result = require('../src/services/paymentResult.service');
const XLSX = require('@e965/xlsx');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const SHEET = 'wt_zeroprice00000001';
const TAB = '0원구매검증탭';
const TAB_H = '0원구매하나탭';
const GID = '900000301', GID_H = '900000302';
const CAMP = 'camp_zeroprice01', CAMP_H = 'camp_zeroprice02';
const WO = 'wo_zeroprice01', WO_H = 'wo_zeroprice02';
const HEADERS = ['번호', '구매일자', '수취인', '연락처', '상품', '결제금액', '리뷰제출', '입금일'];
const WO_ZERO = JSON.stringify([{ name: '더스트 휴그로 H', product_mode: 'none', base: { pay: 0, count: 10, daily: 2 }, options: [] }]);
// seq, 이름, 연락처, 결제금액, 리뷰, 연결 주문 금액(공고 경유 · null = 주문 없음)
const ROWS = [
  [3, '가영원', '010-3000-0003', '0', 'https://r/3', null],      // ★ 대상(손 입력 줄 · 주문 없음)
  [4, '나영원', '010-3000-0004', '', 'https://r/4', null],       // 결제금액 빈칸 → no_price
  [5, '다영원', '010-3000-0005', '0', '', null],                 // 리뷰 미제출 → 대상 아님
  [6, '라영원', '010-3000-0006', '0', 'https://r/6', null],      // 이미 회차(pending) → 대상 아님
  [7, '마영원', '010-3000-0007', '무료', 'https://r/7', null],   // 문자 → no_price
  [8, '바영원', '010-3000-0008', '-1000', 'https://r/8', null],  // 음수 표기 → 0원 구매 아님(종전 숫자 읽기 그대로)
  [9, '사영원', '010-3000-0009', '0', 'https://r/9', '15900'],   // 연결 주문 금액 > 0 → no_price
  [10, '아영원', '010-3000-0010', '0', 'https://r/10', '0'],     // ★ 대상(휴그로 모양 — 공고 경유 주문 0)
];
const key = seq => `${SHEET}||${TAB}||${seq}`;

async function cleanup() {
  for (const t of ['payment_records', 'review_index', 'campaign_participants', 'raw_sheet_tabs', 'index_master', 'participant_edits']) {
    await pool.query(`DELETE FROM ${t} WHERE sheet_id=$1`, [SHEET]).catch(() => {});
  }
  await pool.query(`DELETE FROM payment_result_uploads WHERE batch_id IN (SELECT id FROM payment_batches WHERE created_by='zp-test')`);
  await pool.query(`DELETE FROM payment_batch_items WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM payment_batches WHERE created_by='zp-test'`);
  await pool.query(`DELETE FROM order_submissions WHERE sheet_id IN ($1,$2)`, ['campaign:' + CAMP, SHEET]);
  await pool.query(`DELETE FROM recruit_campaigns WHERE id IN ($1,$2)`, [CAMP, CAMP_H]);
  await pool.query(`DELETE FROM work_orders WHERE id IN ($1,$2)`, [WO, WO_H]);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [SHEET]);
  await pool.query(`DELETE FROM reviewers WHERE phone LIKE '010-3000-%'`);
  await pool.query(`DELETE FROM payment_bank_rows WHERE tid LIKE 'zptest-%'`);
}

async function seedTab(tab, gid, camp, wo, bankChoice, rows) {
  await pool.query(
    `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless, deposit_name)
     VALUES ($1,$2,$3,'0원구매검증',TRUE,'')`, [SHEET, tab, gid]);
  await pool.query(
    `INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name, headers, detected_headers, mirrored_at)
     VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,NOW())`, [SHEET, gid, tab, JSON.stringify(HEADERS)]);
  await pool.query(
    `INSERT INTO recruit_campaigns (id, title, linked_sheet_id, linked_tab_name, linked_tab_gid, transfer_bank, review_fee, transfer_memo, status, work_kind, created_at)
     VALUES ($1,'0원 구매 공고',$2,$3,$4,$5,1500,'휴그로망고','closed','review',NOW())`, [camp, SHEET, tab, gid, bankChoice]);
  await pool.query(
    `INSERT INTO work_orders (id, title, linked_tab_sheet_id, linked_tab_name, pay_amount, goods_cost_type, product_options_json, work_kind, created_at)
     VALUES ($1,'휴그로 자사몰',$2,$3,0,'계산서(농협)',$4,'review',NOW())`, [wo, SHEET, tab, WO_ZERO]);
  for (const [seq, name, phone, price, review, orderPrice] of rows) {
    let orderId = null;
    if (orderPrice != null) {
      const { rows: [o] } = await pool.query(
        `INSERT INTO order_submissions (sheet_id, tab_name, sheet_row, price, orderer, phone, bank, account, depositor, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,'국민은행',$7,$5,NOW()) RETURNING id`,
        ['campaign:' + camp, tab, seq, orderPrice, name, phone, '1234567890' + seq]);
      orderId = o.id;
    }
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, source, active, phone8, recipient_name, identity_key, order_submission_id)
       VALUES ($1,$2,$3,$4::jsonb,'worktable',TRUE,$5,$6,$7,$8)`,
      [SHEET, tab, seq, JSON.stringify({
        '번호': String(seq - 2), '구매일자': '11/3', '수취인': name, '연락처': phone, '상품': '더스트 휴그로 H',
        '결제금액': price, '리뷰제출': review, '입금일': '',
      }), phone.replace(/\D/g, '').slice(-8), name, 'zp:' + tab + ':' + seq, orderId]);
    await pool.query(
      `INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder)
       VALUES ($1,$2,'국민은행',$3,$1)`, [name, phone, '1234567890' + seq]);
  }
  await ledger.rebuildLedgers({ sheetId: SHEET, tabName: tab, columns: HEADERS });
}

async function seed() {
  await cleanup();
  await seedTab(TAB, GID, CAMP, WO, 'kbank', ROWS);
  await seedTab(TAB_H, GID_H, CAMP_H, WO_H, 'hana', [[3, '자영원', '010-3000-0103', '0', 'https://r/h3', null]]);
  // 6번 줄 = 이미 다른 회차에 담김(pending)
  const { rows: [b] } = await pool.query(
    `INSERT INTO payment_batches (bank, created_by, status) VALUES ('kbank','zp-test','downloaded') RETURNING id`);
  await pool.query(
    `INSERT INTO payment_batch_items (batch_id, sheet_id, tab_name, row_index, reviewer_name, phone8, bank_name, bank_account, account_holder,
       product_price, review_fee, amount, status)
     VALUES ($1,$2,$3,6,'라영원','30000006','국민은행','12345678906','라영원',0,1500,1500,'pending')`, [b.id, SHEET, TAB]);
}

async function targets(tab = TAB) {
  const out = await pay.listPaymentTargets({ includeFinished: true, sheetId: SHEET, tabName: tab });
  return new Map(out.items.map(it => [`${it.sheetId}||${it.tabName}||${it.rowIndex}`, it]));
}
const rowState = async (tab, seq) => (await pool.query(
  `SELECT ri.is_submitted2, ri.row_json->>'입금일' AS ri_paid, cp.row_json->>'입금일' AS cp_paid
     FROM review_index ri JOIN campaign_participants cp ON cp.sheet_id=ri.sheet_id AND cp.tab_name=ri.tab_name AND cp.seq=ri.row_index AND cp.active
    WHERE ri.sheet_id=$1 AND ri.tab_name=$2 AND ri.row_index=$3`, [SHEET, tab, seq])).rows[0];

(async () => {
  try {
    await seed();
    const { rows: ri } = await pool.query(`SELECT count(*)::int AS n FROM review_index WHERE sheet_id=$1 AND tab_name=$2`, [SHEET, TAB]);
    ok('재료: 장부 8줄 생성', ri[0].n === 8, ri);

    console.log('\n[1] 대상 — 0원 구매 줄만 리뷰비 1,500');
    let by = await targets();
    for (const seq of [3, 10]) {
      const it = by.get(key(seq));
      ok(`★ ${seq}번 줄 = 대상 · 금액 1,500(제품비 0 + 리뷰비) · 0원 구매 표시 · 케이뱅크`,
        it && it.payable && it.amount === 1500 && it.productPrice === 0 && it.reviewFee === 1500 && it.zeroPricePurchase === true && it.bank === 'kbank',
        it && { p: it.payable, a: it.amount, iss: it.issues, z: it.zeroPricePurchase });
    }
    const held = (seq, issue, why) => {
      const it = by.get(key(seq));
      ok(`${seq}번 줄(${why}) = ${issue} 보류 그대로`, it && !it.payable && it.issues.includes(issue) && it.zeroPricePurchase !== true, it && it.issues);
    };
    held(4, 'no_price', '결제금액 빈칸');
    held(7, 'no_price', '결제금액 문자');
    held(9, 'no_price', '연결 주문 금액 15,900');
    ok('5번 줄(리뷰 미제출) = 목록에 없음', !by.has(key(5)));
    ok('6번 줄(이미 회차 pending) = 목록에 없음', !by.has(key(6)));
    const neg = by.get(key(8));
    ok('8번 줄(-1000 표기) = 0원 구매 아님(종전 숫자 읽기 1,000 + 리뷰비 · 이 변경과 무관한 기존 규칙)', neg && neg.zeroPricePurchase === false && neg.productPrice === 1000, neg && { pp: neg.productPrice, a: neg.amount });

    console.log('\n[2] 같은 줄에서 조건 하나만 바꾸면 종전 보류로');
    const check3 = async (why, issue) => { const it = (await targets()).get(key(3));
      ok(`${why} → ${issue}`, it && !it.payable && it.issues.includes(issue) && it.zeroPricePurchase !== true, it && it.issues); };
    await pool.query(`UPDATE work_orders SET pay_amount=159000, product_options_json=$2 WHERE id=$1`,
      [WO, JSON.stringify([{ name: 'x', base: { pay: 15900 }, options: [] }])]);
    await check3('★ 리뷰오더 결제금액 159,000(작업표만 0)', 'no_price');
    await pool.query(`UPDATE work_orders SET pay_amount=0, product_options_json=$2, deleted_at=NOW() WHERE id=$1`, [WO, WO_ZERO]);
    await check3('리뷰오더 없음(삭제됨)', 'no_price');
    await pool.query(`UPDATE work_orders SET deleted_at=NULL WHERE id=$1`, [WO]);
    await pool.query(`UPDATE recruit_campaigns SET transfer_bank='split_kbank' WHERE id=$1`, [CAMP]);
    await check3('★ 제품비 업체 · 리뷰비 케이(split) 0원', 'not_purchased');
    await pool.query(`UPDATE recruit_campaigns SET transfer_bank='kbank', review_fee=0 WHERE id=$1`, [CAMP]);
    await check3('리뷰비 0', 'no_price');
    await pool.query(`UPDATE recruit_campaigns SET review_fee=1500 WHERE id=$1`, [CAMP]);
    by = await targets();
    ok('되돌리면 다시 대상', by.get(key(3)) && by.get(key(3)).payable && by.get(key(3)).zeroPricePurchase === true);

    console.log('\n[3] 회차 — 제품비 0 · 금액 = 리뷰비 · 0원 구매 박제');
    const pick = seq => ({ sheetId: SHEET, tabName: TAB, rowIndex: seq, payoutFp: by.get(key(seq)).payoutFp, payoutMode: 'ours' });
    const made = await pay.createBatch({ bank: 'kbank', by: 'zp-test', rows: [pick(3), pick(10), { sheetId: SHEET, tabName: TAB, rowIndex: 4 }] });
    ok('회차 2건 · 보류 줄(4)은 그 사유로 건너뜀', made.ok && made.items.length === 2 && made.skipped.some(s => s.key.endsWith('||4') && s.reason === 'no_price'), made);
    const { rows: items } = await pool.query(
      `SELECT * FROM payment_batch_items WHERE batch_id=$1 ORDER BY row_index`, [made.batch.id]);
    ok('박제 = 제품비 0 · 리뷰비 1,500 · 금액 1,500 · zero_price_purchase · is_qna 아님',
      items.length === 2 && items.every(i => Number(i.product_price) === 0 && Number(i.review_fee) === 1500 && Number(i.amount) === 1500
        && i.zero_price_purchase === true && i.is_qna === false), items.map(i => [i.row_index, i.product_price, i.amount, i.zero_price_purchase]));
    ok('★ 「리뷰비만 보낸 건」(JS) 아님', items.every(i => pay.isFeeOnlyItem(i) === false));
    const { rows: [fo] } = await pool.query(`SELECT count(*)::int AS n FROM payment_batch_items WHERE batch_id=$1 AND ${pay.feeOnlyItemSql()}`, [made.batch.id]);
    ok('★ 「리뷰비만 보낸 건」(SQL) 아님', fo.n === 0, fo);
    const { rows: [b6] } = await pool.query(`SELECT count(*)::int AS n FROM payment_batch_items WHERE sheet_id=$1 AND tab_name=$2 AND row_index=6 AND ${pay.feeOnlyItemSql()}`, [SHEET, TAB]);
    ok('표시 없는 옛 모양(6번 · 제품비 0 · 금액 = 리뷰비)은 종전처럼 리뷰비만으로 읽힌다', b6.n === 1, b6);
    const again = await pay.createBatch({ bank: 'kbank', by: 'zp-test', rows: [pick(3)] });
    ok('★ 같은 줄을 다시 담지 않는다(이중 지급 0)', again.ok === false && again.skipped.some(s => s.reason === 'not_target'), again);
    by = await targets();
    ok('회차에 담긴 줄은 목록에서 빠진다', !by.has(key(3)) && !by.has(key(10)));

    console.log('\n[4] 케이뱅크 결과 파일 반영 → 원장 · 페이백 완료 · 작업표 입금일');
    await pool.query(`UPDATE payment_batches SET status='downloaded', last_downloaded_at=NOW(), created_at=NOW() - interval '20 minutes' WHERE id=$1`, [made.batch.id]);
    const kstDot = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '.');
    const T = Date.now() - 10 * 60 * 1000;
    const fileRow = (seq, nm) => ['', kstDot(T), `국민 1234567890${seq}`, nm, '1,500', '0', '휴그로망고', '이체완료'];
    const aoa = [[' ', '이체일시', '입금계좌', '예금주', '이체금액(원)', '수수료(원)', '받는분 통장표시', '처리결과'],
      fileRow(3, '가영원'), fileRow(10, '아영원')];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const found = await result.findBatchForResultFile({ fileName: 'kbank-result.xlsx', base64 });
    ok('결과 파일 → 이 회차', found.batchId === made.batch.id && found.matchedRows === 2, found);
    const applied = await result.autoApplyResultFile({ batchId: found.batchId, fileName: 'kbank-result.xlsx', base64, by: 'zp-test', notifyFailed: false });
    const { rows: st } = await pool.query(`SELECT row_index, status FROM payment_batch_items WHERE batch_id=$1 ORDER BY row_index`, [made.batch.id]);
    ok('회차 항목 2건 이체 완료', applied.autoApplied === true && st.every(r => r.status === 'paid'), { auto: applied.autoApply, st });
    const { rows: pr } = await pool.query(`SELECT row_index, amount FROM payment_records WHERE sheet_id=$1 AND tab_name=$2 ORDER BY row_index`, [SHEET, TAB]);
    ok('원장 = 1,500 × 2(3·10번)', pr.map(r => r.row_index).join(',') === '3,10' && pr.every(r => String(r.amount) === '1500'), pr);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
    for (const seq of [3, 10]) {
      const s = await rowState(TAB, seq);
      ok(`★ ${seq}번 줄 — 리뷰어 페이백 완료(PAID) · 작업표 입금일 칸 기록(일반 입금과 같게)`, s && s.is_submitted2 === 'PAID' && !!s.cp_paid && !!s.ri_paid, s);
    }
    const s4 = await rowState(TAB, 4);
    ok('보류 줄(4)은 그대로(입금일 빈칸)', s4 && s4.is_submitted2 !== 'PAID' && !s4.cp_paid, s4);
    by = await targets();
    ok('★ 받은 줄은 다시 대상에 안 나온다', !by.has(key(3)) && !by.has(key(10)));

    console.log('\n[5] 하나은행 통장 자동확인(이름 대조) → 같은 결과');
    let byH = await targets(TAB_H);
    const h = byH.get(`${SHEET}||${TAB_H}||3`);
    ok('하나 작업 0원 구매 줄 = 대상 · 하나은행', h && h.payable && h.bank === 'hana' && h.zeroPricePurchase === true && h.amount === 1500, h && h.issues);
    const madeH = await pay.createBatch({ bank: 'hana', by: 'zp-test', rows: [{ sheetId: SHEET, tabName: TAB_H, rowIndex: 3, payoutFp: h.payoutFp, payoutMode: 'ours' }] });
    ok('하나 회차 1건 · 0원 구매 박제', madeH.ok && madeH.items.length === 1, madeH);
    const NOW = Date.now(), T5 = NOW - 60 * 60 * 1000;
    await pool.query(`UPDATE payment_batches SET status='downloaded', last_downloaded_at=$2, created_at=$2 WHERE id=$1`, [madeH.batch.id, new Date(T5 - 10 * 60 * 1000).toISOString()]);
    const kst = ms => new Date(ms + 9 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
    bank.__setFetchForTest(async (url) => url.endsWith('/api/bank/accounts')
      ? { status: 200, ok: true, json: async () => ({ accounts: [{ bankCode: '0081', accountNumber: '402' }] }) }
      : { status: 200, ok: true, json: async () => ({ success: true, allPages: true, truncated: false, list: [
        { tradeDT: kst(T5), tradeAmt: 1500, tran_type: 'withdraw', remark1: '자영원', remark3: '타행송금', tid: 'zptest-h1', balance: 1 },
      ] }) });
    await pool.query(`UPDATE payment_bank_sync SET last_synced_at = NULL WHERE bank = 'hana'`);
    const sync = await bank.syncBank({ by: 'zp-test', force: true, env: { POPBILL_RELAY_URL: 'http://relay.test' }, banks: ['hana'] });
    bank.__setFetchForTest(null);
    const autoH = (sync.autoConfirmed || []).find(x => x.batchId === madeH.batch.id);
    ok('통장 자동확인 1건 완료', sync.ok && autoH && autoH.applied === 1, sync.autoConfirmed);
    await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB_H });
    const sh = await rowState(TAB_H, 3);
    ok('★ 통장 확인 경로도 페이백 완료(PAID) · 작업표 입금일 칸 기록', sh && sh.is_submitted2 === 'PAID' && !!sh.cp_paid, sh);
    const { rows: prH } = await pool.query(`SELECT amount FROM payment_records WHERE sheet_id=$1 AND tab_name=$2`, [SHEET, TAB_H]);
    ok('원장 1,500 × 1', prH.length === 1 && String(prH[0].amount) === '1500', prH);
  } catch (e) {
    console.log('  ✗ 예외: ' + (e && e.stack || e)); fail++;
  } finally {
    await cleanup().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
