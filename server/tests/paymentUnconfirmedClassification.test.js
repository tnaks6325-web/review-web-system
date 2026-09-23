'use strict';
/**
 * 이체결과 확인 팝업 — "미확인 이체" 분류 회귀가드 (2026-08-19 회차 #12)
 *
 * 사고: 전건 반영이 끝난 뒤 같은 결과 파일을 다시 올리면 짝맞출 대상(pending)이 0이라
 *       파일의 **모든 줄**이 "짝 없음"이 되어 화면이 그것을 "미확인 이체 518건"이라 불렀다
 *       (실제 미확인은 1건). 미확인 행에는 [작업 검색·대조] → 승인 경로가 붙어 있어
 *       이미 입금된 517건에 **이중 입금**을 낼 입구가 열려 있었다.
 *
 * ★★ 판별 근거는 **정보 일치(계좌 숫자 + 금액)뿐** — 줄 번호를 쓰지 않는다(사용자 확정):
 *    은행 다건이체는 내려받은 순서대로 이체되지 않는 경우가 있어 결과 파일의 행 순서가
 *    회차 순서와 다를 수 있다.
 */
const assert = require('assert');
const XLSX = require('@e965/xlsx');
const svc = require('../src/services/paymentResult.service');

let pass = 0;
/* ★ 스텁 pool 은 모듈 전역이라 **반드시 순차 실행** — 동시에 돌리면 서로의 스텁을 덮어
     엉뚱한 데이터로 판정한다(개발 중 실제로 밟았다). */
let chain = Promise.resolve();
const t = (name, fn) => { chain = chain.then(fn).then(() => { pass++; console.log('  ✓ ' + name); }); };

/* 케이뱅크 서식 최소본(맨 앞 빈 열 · 콤마 금액 · '이체완료') */
function kbankFile(rows) {
  const aoa = [['', '입금계좌', '이체금액', '예금주', '통장표시', '처리결과', '이체일시']];
  for (const r of rows) {
    aoa.push(['', '국민 ' + r.account, r.amount.toLocaleString(), r.holder, r.memo || '',
      r.status || '이체완료', '2026.8.19 16:33:02']);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }).toString('base64');
}

const ITEMS = [
  { id: 'i1', sheet_id: 's', tab_name: 'A', row_index: 1, reviewer_name: '김일', bank_account: '1110001', amount: 10000, account_holder: '김일', transfer_memo: 'm1' },
  { id: 'i2', sheet_id: 's', tab_name: 'A', row_index: 2, reviewer_name: '이이', bank_account: '1110002', amount: 20000, account_holder: '이이', transfer_memo: 'm2' },
  { id: 'i3', sheet_id: 's', tab_name: 'A', row_index: 3, reviewer_name: '박삼', bank_account: '1110003', amount: 30000, account_holder: '박삼', transfer_memo: 'm3' },
];
const FILE_ROWS = [
  { account: '1110001', amount: 10000, holder: '김일', memo: 'm1' },
  { account: '1110002', amount: 20000, holder: '이이', memo: 'm2' },
  { account: '1110003', amount: 30000, holder: '박삼', memo: 'm3' },
  { account: '9990009', amount: 5480, holder: '최밖', memo: '회차밖' },   // 회차 밖 = 진짜 미확인
];

function stub(statuses) {
  svc.__setPoolForTest({ query: async (sql) => {
    if (/FROM payment_batches/i.test(sql)) return { rows: [{ id: 'B', seq: 12, bank: 'kbank', status: 'applied', item_count: ITEMS.length }] };
    if (/FROM payment_batch_items/i.test(sql)) return { rows: ITEMS.map((it, i) => ({ ...it, status: statuses[i] })) };
    return { rows: [] };
  } });
}
const preview = (rows) => svc.previewResultFile({ batchId: 'B', fileName: 'r.xls', base64: kbankFile(rows), persist: false });
const outcomes = (r) => (r.items || []).reduce((m, i) => (m[i.outcome] = (m[i.outcome] || 0) + 1, m), {});

console.log('이체결과 팝업 — 미확인 분류');

t('★★ 반영 후 같은 파일을 다시 올려도 미확인은 회차 밖 1건뿐(517→1 사고 재발 방지)', async () => {
  stub(['paid', 'paid', 'paid']);
  const r = await preview(FILE_ROWS);
  assert.strictEqual(r.unmatchedResults.length, 1, '이미 입금된 건이 미확인으로 새면 이중 입금 입구가 된다');
  assert.strictEqual(r.unmatchedResults[0].holder, '최밖');
  assert.strictEqual(r.summary.unmatchedResults, 1, '요약 수치도 같은 기준이어야 한다');
});

t('★★ 파일 행 순서가 뒤바뀌어도 결과가 같다(은행이 순서를 지키지 않는다)', async () => {
  stub(['paid', 'paid', 'paid']);
  const r = await preview([...FILE_ROWS].reverse());
  assert.strictEqual(r.unmatchedResults.length, 1);
  assert.strictEqual(r.unmatchedResults[0].holder, '최밖');
});

t('★★ 은행이 진짜로 두 번 보낸 줄은 계속 미확인으로 남는다(숨기지 않는다)', async () => {
  stub(['paid', 'paid', 'paid']);
  const r = await preview([...FILE_ROWS, { account: '1110001', amount: 10000, holder: '김일', memo: 'm1' }]);
  assert.strictEqual(r.unmatchedResults.length, 2, '중복 이체가 숨겨지면 이 기능의 의미가 없다');
  assert.deepStrictEqual(r.unmatchedResults.map(x => x.holder).sort(), ['김일', '최밖']);
});

t('★ 이미 입금된 건에 실제 이체시각이 채워진다(종전에는 전부 빈 값)', async () => {
  stub(['paid', 'paid', 'paid']);
  const r = await preview(FILE_ROWS);
  const paid = (r.items || []).filter(i => i.outcome === 'already_paid');
  assert.strictEqual(paid.length, 3);
  assert.ok(paid.every(i => i.transferredAt), '파일에도 DB에도 있는 값을 화면만 비워 두면 안 된다');
});

t('★★ 최초 업로드(전건 pending)는 종전과 완전히 동일하다', async () => {
  stub(['pending', 'pending', 'pending']);
  const r = await preview(FILE_ROWS);
  assert.strictEqual(r.summary.matched, 3);
  assert.strictEqual(r.summary.success, 3);
  assert.strictEqual(r.summary.notInFile, 0);
  assert.strictEqual(r.unmatchedResults.length, 1);
  assert.deepStrictEqual(outcomes(r), { success: 3 });
});

t('★★ 라벨링 2차가 판정을 바꾸지 않는다 — 실패 확정 건이 성공으로 보이지 않는다', async () => {
  stub(['failed', 'paid', 'paid']);
  const r = await preview(FILE_ROWS);   // 파일에는 i1 성공 줄이 있다
  const o = outcomes(r);
  assert.strictEqual(o.success, undefined, '실패로 확정된 건은 파일에 성공 줄이 있어도 성공으로 표시하지 않는다');
  assert.strictEqual(o.already_paid, 2);
  assert.strictEqual(o.not_in_file, 1);
});

t('★ 반영 수치(matched/success/failed/notInFile)는 1차(pending) 기준 그대로', async () => {
  stub(['paid', 'pending', 'pending']);
  const r = await preview(FILE_ROWS);
  assert.strictEqual(r.summary.items, 2, '반영 대상은 여전히 pending 뿐');
  assert.strictEqual(r.summary.success, 2);
  assert.strictEqual(r.summary.alreadyPaid, 1);
});

chain.then(() => {
  console.log('\n✅ paymentUnconfirmedClassification 회귀가드 통과 — ' + pass + '케이스');
  process.exit(0);
}).catch((e) => { console.error('❌ 실패:', e.message); process.exit(1); });
