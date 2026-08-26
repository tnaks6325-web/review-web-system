/**
 * 소유지정 연결탭 정산 컬럼(견적서·마감자료·계산서·입금액/총비용·입금일·비고) 회귀가드.
 *   1. settlementSummaryForAdvertiser — 링크된 탭만 반환, 같은 sales 공유 탭 1회 조회(dedup),
 *      날짜 정규화(YYYYMMDD→YYYY-MM-DD), 입금액=matched_bank_amount, 총비용=견적 우선.
 *   2. 금액 불일치(견적≠계약) — amountMismatch 신호(자동 판정 없음), totalCost 는 견적 금액 유지.
 *   3. 인트라넷 장애 — proxyDown 표기(스로우 금지, fail-soft).
 *   4. saveTabMemo — upsert(ON CONFLICT) + 2000자 캡.
 *   5. Track A 무접촉 — 읽기만(비 trackb 테이블 write 0).
 * 실행: node tests/trackBOwntabSettlement.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}
// ownedTabsForAdvertiser 결과 목(정산 링크 컬럼 포함). T2 는 미링크.
const ownRows = (sales1, sales3) => [
  { sheetId: 'S', tabName: 'T1', salesId: sales1, contractNumber: 'C-88', closeoutDate: '2026-07-28', memo: null },
  { sheetId: 'S', tabName: 'T2', salesId: null, contractNumber: null, closeoutDate: null, memo: '수동 메모' },
  { sheetId: 'S', tabName: 'T3', salesId: sales3, contractNumber: '', closeoutDate: null, memo: null },
];

async function run() {
  const savedFetch = global.fetch;
  const urls = [];
  const salesDb = {
    SA1: { id: 'SA1', contract_number: 'C-88', advertiser_name: '어니스트캄', product_name: '선스틱', amount: 2381126,
           payment_status: 'unpaid', invoice_status: 'issued', invoice_date: '2026-07-31', payment_date: null,
           matched_bank_amount: 1000000, matched_bank_date: '20260620' },
    SA2: { id: 'SA2', contract_number: 'C-99', advertiser_name: '어니스트캄', product_name: '헤어틴트', amount: 3000000,
           payment_status: 'paid', invoice_status: 'not_issued', invoice_date: null, payment_date: '2026-06-25',
           matched_bank_amount: 2500000, matched_bank_date: null },
    // 레거시/일괄등록 계약: 상태문자열은 비어 있지만 발행일·입금 매칭은 이미 존재.
    SA3: { id: 'SA3', contract_number: 'C-100', advertiser_name: '어니스트캄', product_name: '세탁세제', contract_amount: 1354100,
           invoice_date: '2026-08-11', payment_date: '2026-08-11', matched_tax_invoice_id: 'TI-1',
           matched_bank_amount: 1354100, matched_bank_date: '20260811' },
  };
  const quoteDb = { SA1: { quote_number: 'Q-7', status: 'sent', quote_date: '2026-07-01', total_amount: 2381126 },
                    SA2: { quote_number: 'Q-8', status: 'sent', quote_date: '2026-06-10', total_amount: 2500000 } };
  global.fetch = async (url) => {
    const u = String(url); urls.push(u);
    if (u.includes('/api/tables/sales/SFAIL')) throw new Error('boom');
    const ms = u.match(/\/api\/tables\/sales\/(\w+)/);
    if (ms) return { ok: true, json: async () => ({ data: salesDb[ms[1]] || null }) };
    const mq = u.match(/\/api\/tables\/quotes\?where=sales_id=(\w+)/);
    if (mq) return { ok: true, json: async () => ({ data: u.includes('SFAIL') ? [] : [quoteDb[mq[1]]].filter(Boolean) }) };
    return { ok: true, json: async () => ({ data: [] }) };
  };

  // ═══ 1. 요약: 링크 탭만 + sales dedup + 정규화 + 총비용/입금액 ═══
  let p = pool([[/WITH own AS/, () => ({ rows: ownRows('SA1', 'SA1') })]]); svc.__setPoolForTest(p);
  let items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'A1' });
  assert.equal(items.length, 2, '1a: 링크된 탭만(T1,T3) — 미링크 T2 제외');
  assert.equal(urls.filter(u => u.includes('/api/tables/sales/SA1')).length, 1, '1b: 같은 sales 공유 → 1회만 조회(dedup)');
  const t1 = items[0];
  assert.equal(t1.quoteDate, '2026-07-01', '1c: 견적서 생성일');
  assert.equal(t1.invoiceDate, '2026-07-31', '1d: 계산서 발행일');
  assert.equal(t1.paidAmount, 1000000, '1e: 입금액 = matched_bank_amount(입금매칭 누계)');
  assert.equal(t1.paidDate, '2026-06-20', '1f: 입금일 = matched_bank_date, YYYYMMDD→YYYY-MM-DD 정규화');
  assert.equal(t1.totalCost, 2381126, '1g: 총비용 = 견적서상 금액');
  assert.equal(t1.amountMismatch, false, '1h: 견적=계약 → 불일치 아님');
  assert.equal(t1.contractNumber, 'C-88', '1i: 계약번호 동봉');
  console.log('  1. 요약 — 링크만·dedup·날짜 정규화·입금매칭·총비용(견적) ✓');

  // ═══ 2. 견적≠계약 금액 → mismatch 신호, totalCost 는 견적 유지. 입금일 폴백=payment_date ═══
  p = pool([[/WITH own AS/, () => ({ rows: [{ sheetId: 'S', tabName: 'T9', salesId: 'SA2', contractNumber: '', closeoutDate: null, memo: null }] })]]);
  svc.__setPoolForTest(p);
  items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'A1' });
  assert.equal(items[0].totalCost, 2500000, '2a: 총비용 = 견적 금액(계약 3,000,000 아님)');
  assert.equal(items[0].amountMismatch, true, '2b: 견적≠계약 → ⚠ 신호');
  assert.equal(items[0].paidDate, '2026-06-25', '2c: matched_bank_date 없으면 payment_date 폴백');
  console.log('  2. 금액 불일치 신호 + 입금일 폴백 ✓');

  // ═══ 2.5 상태 문자열이 없는 기존 계약도 날짜·은행매칭 증거로 발행/완납을 표시 ═══
  p = pool([[/WITH own AS/, () => ({ rows: [{ sheetId: 'S', tabName: 'T10', salesId: 'SA3', contractNumber: '', closeoutDate: null, memo: null }] })]]);
  svc.__setPoolForTest(p);
  items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'A1' });
  assert.equal(items[0].invoiceStatus, 'issued', '2d: 발행일/계산서 링크가 있으면 발행완료로 파생');
  assert.equal(items[0].paymentStatus, 'paid', '2e: 계약금액과 같은 은행매칭액이면 입금완료로 파생');
  assert.equal(items[0].paidDate, '2026-08-11', '2f: 은행매칭일 정규화');
  console.log('  2.5 기존 계약 상태 보강 — 발행일·은행매칭으로 계산서/입금 파생 ✓');

  // ═══ 3. 인트라넷 장애 → proxyDown(스로우 금지) ═══
  p = pool([[/WITH own AS/, () => ({ rows: [{ sheetId: 'S', tabName: 'TF', salesId: 'SFAIL', contractNumber: 'C-1', closeoutDate: null, memo: null }] })]]);
  svc.__setPoolForTest(p);
  items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'A1' });
  assert.equal(items[0].proxyDown, true, '3a: sales 조회 실패 = proxyDown');
  assert.equal(items[0].quoteDate, null, '3b: 실패 시 필드 null(부분 데이터 미노출)');
  assert.equal(items[0].contractNumber, 'C-1', '3c: 링크의 계약번호는 유지(로컬)');
  console.log('  3. 인트라넷 장애 fail-soft(proxyDown) ✓');

  // ═══ 4. saveTabMemo — upsert + 2000자 캡 ═══
  p = pool([[/INSERT INTO trackb_tab_memos/, (s, prm) => ({ rows: [], rowCount: 1, _prm: prm })]]);
  svc.__setPoolForTest(p);
  let r = await svc.saveTabMemo({ sheetId: 'S', tabName: 'T1', memo: 'x'.repeat(3000), by: 'kim' });
  assert.equal(r.ok, true); assert.equal(r.memo.length, 2000, '4a: 2000자 캡');
  const ins = p.q.find(x => /INSERT INTO trackb_tab_memos/.test(x.s));
  assert.ok(/ON CONFLICT \(sheet_id, tab_name\) DO UPDATE/.test(ins.s), '4b: 탭당 1행 upsert');
  assert.equal(ins.params[3], 'kim', '4c: updated_by 기록');
  r = await svc.saveTabMemo({ sheetId: '', tabName: 'T' });
  assert.equal(r.ok, false, '4d: sheetId 필수');
  console.log('  4. saveTabMemo — upsert·캡·검증 ✓');

  // ═══ 5. Track A 무접촉(요약은 읽기만, 비고는 trackb_tab_memos 만 write) ═══
  const writes = p.q.filter(x => /INSERT|UPDATE|DELETE/i.test(x.s) && !/trackb_/.test(x.s));
  assert.equal(writes.length, 0, '5a: 비 trackb 테이블 write 0');
  console.log('  5. Track A 무접촉 ✓');

  svc.__setPoolForTest(null); global.fetch = savedFetch;
  console.log('✅ trackBOwntabSettlement 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
