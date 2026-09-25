/**
 * 계약 1건에 견적서·세금계산서·입금이 여러 장(선금·중도금·잔금 / 혼합계약 / 비교견적) 회귀가드.
 *   사용자 확정 2026-09-26 — 시뮬레이터(시안) 기준: 끝난 것 = 파란 칸, 진행 중 = 흰 칸 + 아래 파란 선, 없음 = 회색.
 *   A. 견적서: 여러 장 합계 = 총비용 · 반려 제외 · 비교견적은 채택된 안만 · 한 장이면 종전과 같은 값
 *   B. 세금계산서: 발행 합계 < 목표면 partial · 혼합계약 목표 = 계산서 발행분 · 0장이면 종전 상태(수기) · 조회 실패도 종전
 *   C. 업체관리 요약·업체 화면 렌즈에 장수·금액이 실린다(인트라넷 ID 없음)
 *   D. 견적서 문서: 여러 장이면 장마다 따로 버전 기록(한 키에 섞어 가짜 버전이 쌓이던 결함) · 한 장은 종전 키
 *   E. 화면: 정산 칸 3버튼 vm 실행(진행 중 = part + 선) · 견적서 팝업 장 전환 배선
 * 실행: node tests/multiDocSettlement.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/trackB.service');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}

// 인트라넷 픽스처 — salesId 마다 계약·견적·계산서
const DB = {
  S1: { sales: { id: 'S1', contract_number: 'C-1', amount: 10000000, invoice_status: 'issued', invoice_date: '2026-09-01', payment_status: 'unpaid', matched_bank_amount: 3000000 },
        quotes: [{ id: 'q3', quote_number: 'Q-3', status: 'draft', quote_date: '2026-09-03', total_amount: 4000000 },
                 { id: 'q1', quote_number: 'Q-1', status: 'accepted', quote_date: '2026-09-01', total_amount: 3000000 },
                 { id: 'q2', quote_number: 'Q-2', status: 'sent', quote_date: '2026-09-02', total_amount: 3000000 },
                 { id: 'qx', quote_number: 'Q-X', status: 'rejected', quote_date: '2026-08-20', total_amount: 9000000 }],
        inv: [{ sales_id: 'S1', issue_date: '20260901', total_amount: 3000000 }] },
  S2: { sales: { id: 'S2', amount: 10600000, sales_type: 'mixed', invoice_leg_amount: 6600000, invoice_status: 'issued', invoice_date: '2026-09-05', matched_bank_amount: 6600000 },
        quotes: [{ id: 'm1', quote_number: 'M-1', status: 'accepted', quote_date: '2026-09-01', total_amount: 6600000 },
                 { id: 'm2', quote_number: 'M-2', status: 'accepted', quote_date: '2026-09-01', total_amount: 4000000 }],
        inv: [{ sales_id: 'S2', issue_date: '2026-09-05', total_amount: 6600000 }] },
  S3: { sales: { id: 'S3', amount: 8000000, invoice_status: 'not_issued', matched_bank_amount: 0 },
        quotes: [{ id: 'a', quote_number: 'A', status: 'accepted', quote_date: '2026-09-01', total_amount: 8000000, plan_label: 'A', plan_selected: 1 },
                 { id: 'b', quote_number: 'B', status: 'sent', quote_date: '2026-09-01', total_amount: 12000000, plan_label: 'B', plan_selected: 0 }],
        inv: [] },
  S4: { sales: { id: 'S4', amount: 5000000, invoice_status: 'issued', invoice_date: '2026-09-01', payment_status: 'paid', matched_bank_amount: 5000000 },
        quotes: [{ id: 'one', quote_number: 'Q-ONE', status: 'draft', quote_date: '2026-09-01', total_amount: 5000000 }],
        inv: [] },   // 계산서 0장인데 상태만 수기 '발행' → 종전 그대로 발행
  S5: { sales: { id: 'S5', amount: 10000000, invoice_status: 'issued', invoice_date: '2026-09-10', matched_bank_amount: 10000000 },
        quotes: [{ id: 'z', quote_number: 'Z', status: 'accepted', quote_date: '2026-08-01', total_amount: 10000000 }],
        inv: [{ sales_id: 'S5', issue_date: '2026-08-01', total_amount: 3000000 }, { sales_id: 'S5', issue_date: '2026-08-20', total_amount: 3000000 }, { sales_id: 'S5', issue_date: '2026-09-10', total_amount: 4000000 }] },
  S6: { sales: { id: 'S6', amount: 10000000, invoice_status: 'issued', invoice_date: '2026-09-01' }, quotes: [], invFail: true },
  S7: { sales: { id: 'S7', amount: 10000000, invoice_status: 'issued', invoice_date: '2026-09-01' }, quotes: [],
        inv: [{ sales_id: 'S7', issue_date: '20260901', total_amount: 3000000, status: '발행완료' },
              { sales_id: 'S7', issue_date: '20260905', total_amount: 7000000, status: '발행취소' },
              { sales_id: 'S7', issue_date: '20260906', total_amount: 7000000, status: '국세청전송' }] },
  S8: { sales: { id: 'S8', amount: 5000000, invoice_status: 'issued', invoice_date: '2026-09-01' }, quotes: [],
        inv: [{ sales_id: 'S8', issue_date: '20260901', total_amount: 5000000, status: '발행취소' }] },
};

async function run() {
  const savedFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    let m = u.match(/\/api\/tables\/sales\/(\w+)/);
    if (m) return { ok: true, json: async () => ({ data: (DB[m[1]] || {}).sales || null }) };
    m = u.match(/\/api\/tables\/quotes\?where=sales_id=(\w+)/);
    if (m) { ok(/limit=50/.test(u), 'A0: 견적서는 여러 장을 한 번에 받는다(limit=1 부활 금지)'); return { ok: true, json: async () => ({ data: (DB[m[1]] || {}).quotes || [] }) }; }
    m = u.match(/\/api\/tables\/tax_invoices\?where=sales_id=(\w+)/);
    if (m) { if ((DB[m[1]] || {}).invFail) throw new Error('down'); return { ok: true, json: async () => ({ data: (DB[m[1]] || {}).inv || [] }) }; }
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const tab = sid => pool([[/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/, () => ({ rows: [{ salesId: sid, contractNumber: 'C' }] })]]);
  const forTab = async sid => { svc.__setPoolForTest(tab(sid)); return svc.settlementForTab({ sheetId: 'X', tabName: sid, role: 'admin' }); };

  // ═══ A·B. 작업보드 정산 칸 재료 ═══
  let d = await forTab('S1');
  ok(d.quote.totalAmount === 10000000 && d.totalCost === 10000000, 'A1: 총비용 = 견적서 3장 합계(반려 1장 제외)');
  ok(d.quote.count === 3 && d.quote.acceptedCount === 1 && d.quote.status === 'sent', 'A2: 3장 중 1장 수락 → 상태는 첫 미수락 장');
  ok(d.quote.quoteNumber === 'Q-1' && d.quote.quoteDate === '2026-09-01', 'A3: 대표 장 = 날짜가 가장 이른 장(순서 고정 — 볼 때마다 달라지지 않는다)');
  ok(d.invoice.status === 'partial' && d.invoice.issuedAmount === 3000000 && d.invoice.targetAmount === 10000000, 'B1: 계산서 300만/1,000만 → 일부 발행(종전엔 발행완료로 보였다)');
  ok(d.invoice.count === 1, 'B2: 발행 장수');

  d = await forTab('S2');
  ok(d.totalCost === 10600000, 'A4: 혼합계약 총비용 = 두 견적서 합계');
  ok(d.invoice.status === 'issued' && d.invoice.targetAmount === 6600000, 'B3: 혼합계약 계산서 목표 = 발행분(상품구입비 몫 제외) → 완료');

  d = await forTab('S3');
  ok(d.totalCost === 8000000 && d.quote.count === 1, 'A5: 비교견적은 채택된 A안만(B안 1,200만 미포함)');
  ok(d.invoice.status === 'not_issued' && d.invoice.count === 0, 'B4: 계산서 0장 → 종전 상태 그대로');

  d = await forTab('S4');
  ok(d.quote.count === 1 && d.quote.status === 'draft' && d.quote.quoteNumber === 'Q-ONE', 'A6: 한 장이면 종전과 같은 값');
  ok(d.invoice.status === 'issued' && d.invoice.date === '2026-09-01', 'B5: 계산서 연결 0장 + 수기 발행 상태 → 발행 유지(완료 건을 되돌리지 않는다)');

  d = await forTab('S5');
  ok(d.invoice.status === 'issued' && d.invoice.count === 3 && d.invoice.date === '2026-09-10', 'B6: 3장 합계가 목표에 닿으면 완료 · 날짜는 마지막 장');

  d = await forTab('S6');
  ok(d.invoice.status === 'issued' && d.invoice.count === 0, 'B7: 계산서 조회 실패 → 종전 상태(모르는 채로 일부라고 말하지 않는다)');

  d = await forTab('S7');
  ok(d.invoice.status === 'issued' && d.invoice.count === 2 && d.invoice.issuedAmount === 10000000, 'B8: 발행취소 계산서는 합계에서 뺀다 · 국세청전송은 발행으로 센다');

  d = await forTab('S8');
  ok(d.invoice.status === 'not_issued' && d.invoice.issuedAmount === 0, 'B9: 유일한 계산서가 취소됐으면 수기 발행 상태로 접지 않고 미발행(코덱스 P1)');

  // ═══ C. 업체관리 요약 · 업체 화면 ═══
  const own = [{ sheetId: 'S', tabName: 'T1', salesId: 'S1', contractNumber: 'C-1' }, { sheetId: 'S', tabName: 'T2', salesId: 'S2' }];
  svc.__setPoolForTest(pool([[/WITH own AS/, () => ({ rows: own })]]));
  const items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'A' });
  const t1 = items.find(i => i.tabName === 'T1'), t2 = items.find(i => i.tabName === 'T2');
  ok(t1.totalCost === 10000000 && t1.quoteCount === 3 && t1.quoteAccepted === 1, 'C1: 업체관리 총비용 = 견적 합계 + 장수');
  ok(t1.invoiceStatus === 'partial' && t1.invoiceIssuedAmount === 3000000 && t1.invoiceTargetAmount === 10000000, 'C2: 업체관리 계산서 일부 발행');
  ok(t2.invoiceStatus === 'issued' && t2.amountMismatch === false, 'C3: 혼합계약 = 발행 완료, 견적 합계 = 계약 금액');
  svc.__setPoolForTest(pool([[/WITH own AS/, () => ({ rows: own })]]));
  const sum = await svc.advertiserWorkSummary({ advertiserId: 'A' });
  const a1 = sum.items.find(i => i.tabName === 'T1').settlement;
  ok(a1.invoiceStatus === 'partial' && a1.quoteCount === 3 && a1.invoiceIssuedAmount === 3000000, 'C4: 업체 화면에도 진행 재료');
  ok(!('salesId' in a1), 'C5: 업체 화면은 여전히 인트라넷 계약 ID 없음');

  // ═══ D. 견적서 문서 — 장마다 버전 기록 ═══
  const snaps = [];
  const docPool = sid => pool([
    [/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/, () => ({ rows: [{ salesId: sid, contractNumber: 'C' }] })],
    [/SELECT version, content_hash FROM trackb_quote_snapshots/, () => ({ rows: [] })],
    [/INSERT INTO trackb_quote_snapshots/, (s, p) => { snaps.push(p[0]); return { rows: [] }; }],
    [/SELECT version, payload, captured_at/, (s, p) => ({ rows: [{ version: 1, payload: { quoteNumber: p[0] }, capturedAt: null }] })],
  ]);
  svc.__setPoolForTest(docPool('S1'));
  let doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S1', role: 'admin' });
  ok(doc.docs.length === 3 && doc.docs.map(x => x.quoteNumber).join() === 'Q-1,Q-2,Q-3', 'D1: 여러 장 = 장마다 문서(반려 제외 · 날짜 순)');
  ok(snaps.join() === 'S1#q1,S1#q2,S1#q3', 'D2: 여러 장이면 장마다 다른 기록 키(한 키에 섞여 가짜 버전이 쌓이지 않는다)');
  ok(doc.versions === doc.docs[0].versions, 'D3: versions = 첫 장(구버전 화면 호환)');
  snaps.length = 0;
  svc.__setPoolForTest(docPool('S4'));
  doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S4', role: 'admin' });
  ok(snaps.join() === 'S4' && doc.docs.length === 1, 'D4: 한 장이면 종전 키 그대로(과거 기록 보존)');

  // D5: 1장→여러 장 전환 — 옛 키(sales_id)의 같은 견적번호 기록을 그 장 앞에 이어 붙인다(코덱스 리뷰 P2)
  const legacyPool = pool([
    [/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/, () => ({ rows: [{ salesId: 'S1', contractNumber: 'C' }] })],
    [/content_hash AS "hash" FROM trackb_quote_snapshots/, () => ({ rows: [
      { version: 1, payload: { quoteNumber: 'Q-1', status: 'draft' }, capturedAt: '2026-08-01', hash: 'h1' },
      { version: 2, payload: { quoteNumber: 'Q-1', status: 'accepted' }, capturedAt: '2026-08-05', hash: 'h2' },
      { version: 3, payload: { quoteNumber: 'OTHER' }, capturedAt: '2026-08-06', hash: 'h3' }] })],
    [/SELECT version, content_hash FROM trackb_quote_snapshots/, () => ({ rows: [] })],
    [/INSERT INTO trackb_quote_snapshots/, () => ({ rows: [] })],
    [/SELECT version, payload, captured_at/, (sq, p) => ({ rows: p[0] === 'S1#q1' ? [{ version: 1, payload: { quoteNumber: 'Q-1', status: 'accepted', v: 'new' }, capturedAt: '2026-09-01' }] : [] })],
  ]);
  svc.__setPoolForTest(legacyPool);
  doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S1', role: 'admin' });
  const q1 = doc.docs.find(x => x.quoteNumber === 'Q-1');
  ok(q1.versions.length === 3 && q1.versions[0].payload.status === 'draft' && q1.versions[2].payload.v === 'new', 'D5: 옛 기록 2개(초안·최종) + 새 기록 1개가 이어진다 — 다른 견적번호 기록은 섞지 않는다');
  ok(q1.versions.map(v => v.version).join() === '1,2,3', 'D6: 버전 번호는 이어서 다시 매긴다');
  ok(!legacyPool.q.some(x => /DELETE|UPDATE trackb_quote_snapshots/.test(x.s)), 'D7: 옛 기록은 지우지도 옮기지도 않는다(읽기만)');

  global.fetch = savedFetch;

  // ═══ E. 화면 ═══
  const wd = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
  const cut = (a, b) => { const i = wd.indexOf(a); const j = wd.indexOf(b, i); assert.ok(i >= 0 && j > i, '추출 실패 ' + a); return wd.slice(i, j); };
  const box = { STATE: { role: 'admin' }, esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.createContext(box);
  vm.runInContext(cut('function _awMD(', 'function _awListHtml(').replace(/function _awListHtml[\s\S]*$/, ''), box);
  vm.runInContext(cut('function _wonFmt(n)', 'async function loadSettlement('), box);
  vm.runInContext(cut('function setlSummaryHtml(d){', 'function openSettlementDocument('), box);
  const cls = (html, i) => (html.match(/class="tp3doc( [^"]*)?"/g) || [])[i] || '';
  // 선금만 끝난 상태
  let h = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q-1', count: 3, acceptedCount: 1 },
    invoice: { status: 'partial', issuedAmount: 3000000, targetAmount: 10000000, count: 1 }, payment: { status: 'unpaid' }, paidAmount: 3000000, totalCost: 10000000 });
  ok(/ part/.test(cls(h, 0)) && !/ready/.test(cls(h, 0)) && /3장 중 1장 수락/.test(h), 'E1: 견적서 3장 중 1장 수락 = 진행 중');
  ok(/ part/.test(cls(h, 1)) && /300만 \/ 1,000만/.test(h), 'E2: 계산서 일부 = 진행 중 + 금액');
  ok(/ part/.test(cls(h, 2)) && (h.match(/tp3meter/g) || []).length === 3, 'E3: 입금 일부 = 진행 중 + 세 칸 모두 아래 선');
  ok(/tp3meter" style="width:30\.0%"/.test(h), 'E4: 선 길이 = 끝난 금액 비율');
  ok(!/disabled/.test(h), 'E5: 진행 중 칸은 눌러서 볼 수 있다(비활성 금지)');
  // 모두 끝난 상태
  h = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q-1', count: 3, acceptedCount: 3 },
    invoice: { status: 'issued', count: 3, date: '2026-09-10' }, payment: { status: 'paid' }, paidAmount: 10000000, totalCost: 10000000, paidDate: '2026-09-12' });
  ok(/ready/.test(cls(h, 0)) && /ready/.test(cls(h, 1)) && /ready/.test(cls(h, 2)) && !/tp3meter/.test(h), 'E6: 모두 끝나면 세 칸 파랑·선 없음');
  ok(/3장 수락/.test(h) && /3장 완료/.test(h), 'E7: 장수 표기');
  // 한 장짜리(평소) — 종전과 같은 모양
  h = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q', count: 1, acceptedCount: 0, quoteDate: '2026-09-01' },
    invoice: { status: 'not_issued', count: 0 }, payment: { status: 'unpaid' }, paidAmount: 0, totalCost: 5000000 });
  ok(/ready/.test(cls(h, 0)) && /9\/1/.test(h) && !/ part/.test(h), 'E8: 한 장짜리는 종전대로(견적 파랑 · 날짜)');
  ok(!/purple|#7c3aed|--part/.test(cut('.tp3doc.part{', '.tp3doc:disabled{')), 'E9: 진행 중에 새 색을 쓰지 않는다(시안 확정)');
  ok(/\.tp3doc \.tp3meter\{position:absolute;left:0;bottom:0;height:2px;background:var\(--accent\)/.test(wd), 'E10: 진행선 = 기존 파랑');
  ok(/function _qdocPick\(di\)/.test(wd) && /onclick="_qdocPick\(\$\{di\}\)"/.test(wd), 'E11: 견적서 팝업 장 전환(인덱스만 전달)');
  ok(/partial:\['일부 발행',''\]/.test(wd), 'E12: 업체 화면 계산서 칩 "일부 발행"');
  ok(/const qMany=s&&s\.quoteCount>1;/.test(wd) && /수락 \$\{s\.quoteAccepted\|\|0\}\/\$\{s\.quoteCount\}/.test(wd), 'E13: 업체 화면 견적서 칩 = 여러 장이면 "수락 N/M"(첫 미수락 장 상태만 보이지 않게)');

  console.log(`✅ multiDocSettlement: ${pass} cases passed`);
  process.exit(0);
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
