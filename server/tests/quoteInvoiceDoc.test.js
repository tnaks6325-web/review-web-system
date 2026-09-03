/**
 * quoteInvoiceDoc.test.js — 견적서·계산서 팝업 뷰어 회귀가드.
 *   시안 = frontend/docs/design-vendor-search-quotes-brands.html §2 (사용자 확정).
 *
 * 고정하는 것:
 *   1. 라우터: GET /workdesk/quote-doc · /workdesk/invoice-doc 존재 + authMiddleware +
 *      advertiserId 는 토큰에서만(IDOR 차단, /workdesk/settlement 와 동일 게이트).
 *   2. quoteDocForTab(스텁 pool + 스텁 fetch 실행):
 *      - 광고주 settlement_visible=FALSE → hidden(내용·프록시 0회)
 *      - 미연결 탭 → linked:false
 *      - 연결 탭 → 인트라넷 quotes 상세(품목 파싱) + 스냅샷 v1 적재
 *      - 같은 내용 재조회 → 스냅샷 추가 0회(해시 동일)
 *      - 상태 전이(draft→accepted) → v2 적재(초안/최종 자동 라벨 근거)
 *   3. invoiceDocForTab: tax_invoices 역링크 요약 + 팝빌 UID 는 뒤 4자리만(전체 미노출).
 *   4. 프론트 배선: 목록 표 견적서/계산서 칸 클릭 → awDocOpen, 인트라넷 PDF와 같은 실물 견적서 페이지,
 *      버전 탭, 인쇄, 원본(홈택스) 안내.
 *
 * 실행: node tests/quoteInvoiceDoc.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const svc = require('../src/services/trackB.service');
const router = require('../src/routes/trackB.routes');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}

// 인트라넷 프록시 스텁 — quote 픽스처는 가변(상태 전이 시나리오용)
let fetchCalls = 0;
const quoteFix = {
  quote_number: 'Q-20260630-012', quote_type: 'online_marketing', receiver: '어니스트캄 귀하',
  work_name: '넛세린 선스틱 리뷰 캠페인', quote_date: '2026-07-02', valid_period: '견적일로부터 7일',
  manager_name: '김담당', manager_phone: '010-0000-1234',
  items: JSON.stringify([
    { name: '쿠팡 구매평 리뷰 (포토)', unit_price: 15000, count: 100, amount: 1500000, tax: 150000, note: '' },
  ]),
  supply_amount: 1500000, vat_amount: 150000, total_amount: 1650000, status: 'draft',
};
global.fetch = async (url) => {
  fetchCalls++;
  const u = String(url);
  if (u.includes('/api/tables/quotes')) return { ok: true, json: async () => ({ data: [quoteFix] }) };
  if (u.includes('/api/tables/tax_invoices')) return { ok: true, json: async () => ({ data: [
    { invoice_type: '매출', issue_date: '2026-07-31', supplier_name: '인애드', recipient_name: '어니스트캄',
      item_name: '온라인마케팅 대행', supply_amount: 1500000, tax_amount: 150000, total_amount: 1650000,
      status: 'issued', popbill_uid: 'PB-20260731-XYZ-9911' },
  ] }) };
  if (u.includes('/api/tables/sales/')) return { ok: true, json: async () => ({ data: {
    id: 'sales-doc1', contract_number: 'C-2026-100', advertiser_name: '어니스트캄', product_name: '선스틱',
    amount: 1650000, invoice_status: 'issued', invoice_date: '2026-07-31', payment_status: 'partial',
  } }) };
  if (u.includes('/api/brand-assets/active/')) return { ok: true, json: async () => ({ data: {
    mime_type: 'image/png', file_data: 'aGVsbG8=',
  } }) };
  return { ok: false, json: async () => ({}) };
};

// 스냅샷 스텁(append-only 원장 재현)
const snaps = [];
const docRoutes = (visible, linked) => [
  [/SELECT settlement_visible FROM trackb_advertiser_prefs/, () => ({ rows: [{ settlement_visible: visible }] })],
  [/FROM trackb_settlement_links/, () => ({ rows: linked ? [{ salesId: 'sales-doc1', contractNumber: 'C-2026-100' }] : [] })],
  [/SELECT version, content_hash FROM trackb_quote_snapshots/, () => ({ rows: snaps.length ? [snaps[snaps.length - 1]] : [] })],
  [/INSERT INTO trackb_quote_snapshots/, (s, p) => { snaps.push({ version: p[1], content_hash: p[2], payload: JSON.parse(p[3]) }); return { rowCount: 1 }; }],
  [/SELECT version, payload, captured_at/, () => ({ rows: snaps.map(x => ({ version: x.version, payload: x.payload, capturedAt: '2026-08-06T00:00:00Z' })) })],
];

async function run() {
  /* ═══ 1. 라우터 스택 실검사 ═══ */
  const layers = router.stack.filter(l => l.route).map(l => ({ path: l.route.path, methods: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name) }));
  for (const p of ['/workdesk/quote-doc', '/workdesk/invoice-doc']) {
    const r = layers.find(l => l.path === p);
    ok(`GET ${p} 라우트가 등록돼 있다`, r && r.methods.includes('get'));
    ok(`${p} 는 authMiddleware 뒤(무인증 차단)`, r.mw.includes('authMiddleware'));
  }
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  for (const key of ["'/workdesk/quote-doc'", "'/workdesk/invoice-doc'"]) {
    const seg = routeSrc.slice(routeSrc.indexOf(key), routeSrc.indexOf(key) + 700);
    ok(`★ ${key} advertiserId 는 토큰에서만(쿼리 미수신 · IDOR 차단)`,
      seg.includes('req.admin.advertiser_id') && !/req\.(query|body)\.advertiserId/.test(seg));
    ok(`${key} 게이트 = _ensureThreadScope(정산 조회와 동일)`, seg.includes('_ensureThreadScope'));
  }

  /* ═══ 2. quoteDocForTab 실행 ═══ */
  // 광고주 노출토글 OFF → hidden + 프록시 0회
  svc.__setPoolForTest(pool(docRoutes(false, true)));
  fetchCalls = 0;
  const hid = await svc.quoteDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('★ 광고주 토글 OFF = hidden(내용 미포함)', hid.hidden === true && !hid.versions);
  ok('★ 토글 OFF 면 인트라넷 프록시 0회', fetchCalls === 0);

  // 미연결 탭
  svc.__setPoolForTest(pool(docRoutes(true, false)));
  const un = await svc.quoteDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('미연결 탭 = linked:false(스로우 없음)', un.linked === false && !un.hidden);

  // 연결 탭 — v1 적재 + 품목 파싱
  svc.__setPoolForTest(pool(docRoutes(true, true)));
  const d1 = await svc.quoteDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('연결 탭 = versions 1건(v1) + 계약번호', d1.linked === true && d1.versions.length === 1 && d1.contractNumber === 'C-2026-100');
  const p1 = d1.versions[0].payload;
  ok('품목 JSON 파싱(이름·단가·수량·금액·세액)', p1.items.length === 1 && p1.items[0].unitPrice === 15000 && p1.items[0].tax === 150000);
  ok('견적 유형·수신자·합계 동봉', p1.quoteType === 'online_marketing' && p1.receiver === '어니스트캄 귀하' && p1.totalAmount === 1650000);
  ok('상태 draft(초안 라벨 근거)', p1.status === 'draft');
  ok('실물 견적서용 활성 로고·직인 data URI 동봉', d1.brandAssets && d1.brandAssets.logoHorizontal === 'data:image/png;base64,aGVsbG8=' && d1.brandAssets.companySeal === 'data:image/png;base64,aGVsbG8=');

  // 같은 내용 재조회 — 스냅샷 추가 0
  await svc.quoteDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('★ 같은 내용 재조회 = 스냅샷 추가 0(해시 동일)', snaps.length === 1);

  // 상태 전이 draft→accepted — v2 적재
  quoteFix.status = 'accepted'; quoteFix.total_amount = 1980000; quoteFix.supply_amount = 1800000; quoteFix.vat_amount = 180000;
  const d2 = await svc.quoteDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('★ 내용·상태 변경 = v2 적재(초안이 v1 로 보존)', snaps.length === 2 && d2.versions.length === 2);
  ok('v1 은 초안 그대로(합계 1,650,000·draft)', d2.versions[0].payload.status === 'draft' && d2.versions[0].payload.totalAmount === 1650000);
  ok('v2 는 최종(수락·합계 1,980,000)', d2.versions[1].payload.status === 'accepted' && d2.versions[1].payload.totalAmount === 1980000);

  /* ═══ 3. invoiceDocForTab 실행 ═══ */
  svc.__setPoolForTest(pool(docRoutes(true, true)));
  const inv = await svc.invoiceDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('발행 이력 1건 매핑(발행일·공급가·세액·합계)', inv.linked === true && inv.records.length === 1
    && inv.records[0].issueDate === '2026-07-31' && inv.records[0].supplyAmount === 1500000 && inv.records[0].totalAmount === 1650000);
  ok('★ 팝빌 UID 는 뒤 4자리만(전체 미노출)', inv.records[0].popbillTail === '9911' && !JSON.stringify(inv).includes('PB-20260731'));
  ok('sales 상태 동봉(발행완료 폴백 카드 재료)', inv.invoice && inv.invoice.status === 'issued');

  svc.__setPoolForTest(pool(docRoutes(false, true)));
  const invHid = await svc.invoiceDocForTab({ sheetId: 's1', tabName: 't1', role: 'advertiser', advertiserId: 'adv-1' });
  ok('계산서도 광고주 토글 OFF = hidden', invHid.hidden === true && !invHid.records);

  /* ═══ 4. 프론트 배선(workdesk.html) ═══ */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  ok('목록 표 견적서 칸 클릭 → awDocOpen(quote)', /onclick="awDocOpen\(event,'quote',\$\{i\}\)"/.test(src));
  ok('목록 표 계산서 칸 클릭 → awDocOpen(invoice)', /onclick="awDocOpen\(event,'invoice',\$\{i\}\)"/.test(src));
  ok('셀 클릭이 행 이동(selTab)과 분리(stopPropagation)', /function awDocOpen[\s\S]{0,200}stopPropagation/.test(src));
  ok('정산 카드 6칸의 견적서·계산서도 클릭 열람', /class="ambox st docv" onclick="awDocOpen\(event,'quote'\)"/.test(src));
  ok('버전 탭(초안/최종 자동 라벨) 렌더', src.includes("_QDOC_ST={draft:['초안'") && src.includes('qvtab'));
  ok('인쇄/PDF 저장 버튼', src.includes('_qdocPrint'));
  ok('계산서 원본(홈택스) 안내 문구', src.includes('국세청 홈택스'));
  ok('인트라넷 PDF와 같은 단일 실물 견적서 페이지(794×1123) 렌더', src.includes('qdoc-official-page') && src.includes('width:794px;height:1123px'));
  ok('인트라넷 활성 로고·직인·워터마크를 실물 문서에 적용', src.includes('_QDOC_ASSETS=r.brandAssets||{}') && src.includes("_qdocAsset('companySeal')") && src.includes("_qdocAsset('logoSquare')"));
  ok('상품구입비용·3.3% 근거표도 공식 PDF 기준으로 분기', src.includes("quoteType==='online_marketing'") && src.includes('상품 구입 비용') && src.includes('_qdocTax33Rows(q.outsourcingItems)'));

  console.log(`\n✅ quoteInvoiceDoc: ${n} cases passed`);
}
run().then(() => process.exit(0)).catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
