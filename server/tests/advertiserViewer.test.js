/**
 * advertiserViewer.test.js — 업체용(광고주) 뷰어 화면 정돈 회귀가드.
 *   시안 = frontend/docs/design-advertiser-viewer.html (사용자 확정, PR #452).
 *
 * 고정하는 것:
 *   1. 라우터: GET /api/trackb/my-work-summary 존재 + advertiser 전용 게이트를 **실행으로** 검증
 *      (내부 역할 403 · advertiser_id 없는 광고주 403 · 정상 광고주 ok). advertiserId 는 쿼리 미수신(IDOR 차단).
 *   2. 서비스 렌즈(advertiserWorkSummary, 스텁 pool + 스텁 fetch 실행): 내부 필드(비고 memo·담당 manager·
 *      salesId·amountMismatch) 미노출, 정산 노출 토글 OFF 면 settlement 미계산(settlementHidden).
 *   3. settlementForTab 확장: paidAmount/paidDate 동봉(광고주 정산 카드 금액 4칸 재료).
 *   4. 프론트 배선: body.advm 상한 규칙의 **선언 순서**(data-vw 뒤 · widemode 앞 — 같은 특이성이라 순서가 규칙),
 *      FHD/QHD 토글 광고주 미노출, 좌측 작업 목록(awside)·화면 A 표(남은 입금액 컬럼)·정산 카드 상시 펼침·
 *      내부 용어(원본 배지·계약 연결 문구·담당·Parity) 광고주 미노출.
 *
 * 실행: node tests/advertiserViewer.test.js
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

// 소유 탭 1건(정산 링크 있음) — memo·manager 등 내부 필드 포함(렌즈가 걸러야 함)
const ownedRow = {
  sheetId: 'S1', spreadsheetTitle: '어니스트캄_업무시트 1', tabGid: '11',
  tabName: '4/21(쿠팡)엘라비에_선크림 750건', rowCount: 750, firstSeenAt: null,
  bTotal: 675, bSub: 651, bPaid: 651, manager: '만두', woRecruit: 750, woStartDate: '2026-04-21',
  salesId: 'sales-1', contractNumber: 'C-2026-041',
  closeoutDate: null, closeoutRows: null, closeoutSubs: null, memo: '내부 비고 텍스트', active: true,
};
const ownedRoutes = (visible) => [
  [/WITH own AS/, () => ({ rows: [ownedRow] })],
  [/SELECT settlement_visible FROM trackb_advertiser_prefs/, () => ({ rows: [{ settlement_visible: visible }] })],
];
// 인트라넷 프록시 스텁(sales 단건 + quotes 역파생) — 호출 수 계량(토글 OFF = 프록시 0회 검증)
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls++;
  const u = String(url);
  if (u.includes('/api/tables/sales/')) return { ok: true, json: async () => ({ data: {
    id: 'sales-1', contract_number: 'C-2026-041', advertiser_name: '어니스트캄', product_name: '선크림',
    manager: '내부담당자', amount: 11000000, payment_status: 'partial', invoice_status: 'issued',
    payment_date: null, invoice_date: '2026-06-09', matched_bank_amount: 8000000, matched_bank_date: '20260610',
  } }) };
  if (u.includes('/api/tables/quotes')) return { ok: true, json: async () => ({ data: [
    { quote_number: 'Q-2026-0412', status: 'accepted', quote_date: '2026-06-08', total_amount: 11250000 },
  ] }) };
  return { ok: false, json: async () => ({}) };
};

async function run() {
  /* ═══ 1. 라우터 스택 실검사 ═══ */
  const layers = router.stack.filter(l => l.route).map(l => ({
    path: l.route.path, methods: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name),
    handler: l.route.stack[l.route.stack.length - 1].handle,
  }));
  const mws = layers.find(l => l.path === '/my-work-summary');
  ok('GET /my-work-summary 라우트가 등록돼 있다', mws && mws.methods.includes('get'));
  ok('authMiddleware 뒤에 있다(무인증 차단)', mws.mw.includes('authMiddleware'));

  const call = async (admin) => {
    let code = 200, body = null;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
    await mws.handler({ admin, query: {}, body: {} }, res, (e) => { throw e; });
    return { code, body };
  };
  // 내부 역할은 403 — 내부는 기존 /ownership/settlement(소유지정 뷰)를 쓴다.
  for (const role of ['master', 'admin', 'staff']) {
    const r = await call({ role, name: 'x' });
    ok(`${role} 는 403(광고주 전용 경로)`, r.code === 403);
  }
  ok('advertiser_id 없는 광고주 토큰은 403', (await call({ role: 'advertiser', name: 'x' })).code === 403);

  svc.__setPoolForTest(pool(ownedRoutes(true)));
  const okRes = await call({ role: 'advertiser', name: '어니스트캄', advertiser_id: 'adv-1' });
  ok('정상 광고주는 ok:true + items 반환', okRes.code === 200 && okRes.body && okRes.body.ok === true && Array.isArray(okRes.body.items));

  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  const seg = routeSrc.slice(routeSrc.indexOf("'/my-work-summary'"), routeSrc.indexOf("'/my-work-summary'") + 700);
  ok('★ advertiserId 는 토큰(req.admin.advertiser_id)에서만 — 쿼리/바디 미수신(IDOR 차단)',
    seg.includes('req.admin.advertiser_id') && !/req\.(query|body)\.advertiserId/.test(seg));

  /* ═══ 2. advertiserWorkSummary 렌즈(실행) ═══ */
  svc.__setPoolForTest(pool(ownedRoutes(true)));
  fetchCalls = 0;
  const sum = await svc.advertiserWorkSummary({ advertiserId: 'adv-1' });
  ok('settlementHidden=false + 항목 1건', sum.settlementHidden === false && sum.items.length === 1);
  const it = sum.items[0];
  ok('카운트·목표·시작일 동봉', it.total === 675 && it.submitted === 651 && it.paid === 651 && it.target === 750 && it.startDate === '2026-04-21');
  ok('★ 내부 필드(비고 memo·담당 manager·salesId) 는 항목에 아예 없다 — 화면에서만 감추는 건 보안연극',
    !('memo' in it) && !('manager' in it) && !('salesId' in it));
  ok('정산: 총비용=견적서 금액 우선(11,250,000) · 입금액=입금매칭 누계(8,000,000)',
    it.settlement && it.settlement.totalCost === 11250000 && it.settlement.paidAmount === 8000000);
  ok('정산: 견적 상태·계산서 상태·입금일 정규화(YYYYMMDD→YYYY-MM-DD)',
    it.settlement.quoteStatus === 'accepted' && it.settlement.invoiceStatus === 'issued' && it.settlement.paidDate === '2026-06-10');
  ok('정산 항목에도 내부 필드(salesId·amountMismatch) 없음',
    !('salesId' in it.settlement) && !('amountMismatch' in it.settlement));

  // 정산 노출 토글 OFF: settlement 미계산(인트라넷 프록시 0회) + settlementHidden 신호
  svc.__setPoolForTest(pool(ownedRoutes(false)));
  fetchCalls = 0;
  const hid = await svc.advertiserWorkSummary({ advertiserId: 'adv-1' });
  ok('토글 OFF: settlementHidden=true + settlement=null', hid.settlementHidden === true && hid.items[0].settlement === null);
  ok('★ 토글 OFF 면 인트라넷 프록시를 아예 안 부른다(프록시 0회)', fetchCalls === 0);

  /* ═══ 3. settlementForTab 확장 필드(광고주 정산 카드 금액 4칸 재료) ═══ */
  svc.__setPoolForTest(pool([
    [/FROM trackb_settlement_links WHERE sheet_id=\$1/, () => ({ rows: [{ salesId: 'sales-1', quoteId: null, contractNumber: 'C-2026-041', linkedBy: '만두' }] })],
    [/SELECT settlement_visible FROM trackb_advertiser_prefs/, () => ({ rows: [{ settlement_visible: true }] })],
    [/FROM trackb_tab_closeouts/, () => ({ rows: [] })],
  ]));
  const st = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'advertiser', advertiserId: 'adv-1' });
  ok('settlementForTab 이 paidAmount/paidDate 를 동봉한다(추가만 — 기존 필드 불변)',
    st.paidAmount === 8000000 && st.paidDate === '2026-06-10' && st.amount === 11000000 && st.quote && st.quote.totalAmount === 11250000);
  ok('광고주 렌즈: linkedBy(내부 연결자)·salesInfo.manager 미노출', st.linkedBy === undefined && (!st.salesInfo || st.salesInfo.manager === undefined));

  /* ═══ 4. 프론트 배선(workdesk.html) ═══ */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)[1];
  const css = style.replace(/\/\*[\s\S]*?\*\//g, '');

  // ── 폭 상한: 선언 순서가 규칙(같은 특이성 → 뒤가 이김) ──
  const iQhd = css.indexOf('body[data-vw="qhd"]'), iAdv = css.indexOf('body.advm{--app-max:1680px}'), iWide = css.indexOf('body.widemode{--app-max:100vw}');
  ok('★ body.advm 상한(1680px)이 존재한다', iAdv > -1);
  ok('★ 선언 순서: data-vw 뒤(광고주 고정이 이김) · widemode 앞(전체화면은 해제)', iQhd > -1 && iWide > -1 && iQhd < iAdv && iAdv < iWide);
  ok('renderShell 이 광고주일 때 body.advm 을 붙인다', /classList\.toggle\('advm',\s*isAdv\)/.test(src));
  ok('renderLogin 이 advm 잔재를 제거한다(로그아웃·만료 후 원복)', /renderLogin[\s\S]{0,300}classList\.remove\('advm'\)/.test(src));
  ok('★ FHD/QHD 토글은 광고주에게 안 그린다', /\$\{isAdv\?'':`<div class="vwsw"/.test(src));

  // ── 작업 선택 = 좌측 세로 목록(업체관리 차용) ──
  ok('광고주 작업대 = awside 사이드바 + advwrap 그리드(가로 탭바 없음)',
    src.includes('class="wrap advwrap') && src.includes('id="awside"') );
  ok('advwrap 3열 그리드(사이드바 224px + 본문 + 레일)', /\.wrap\.advwrap\{grid-template-columns:224px minmax\(0,1fr\) 300px\}/.test(css));
  ok('_renderTabList 광고주 분기 → _renderAdvSidebar(세그먼트/탭바 미참조)',
    /_renderTabList\(\)\{\s*\n?\s*if\(STATE\.role==='advertiser'\)\{ _renderAdvSidebar\(\); return; \}/.test(src));
  ok('loadTabs 가 광고주면 /my-work-summary 를 함께 받는다', src.includes("api('/api/trackb/my-work-summary')"));

  // ── 화면 A: 내 작업 목록 표 ──
  ok('화면 A 컬럼: 시작일·진행상황·견적서·계산서·총비용·입금액·입금일·남은 입금액',
    /<span>시작일<\/span><span>작업명<\/span><span>진행상황<\/span><span>참여·제출·입금<\/span><span>견적서<\/span><span>계산서<\/span><span>총비용<\/span><span>입금액<\/span><span>입금일<\/span><span>남은 입금액<\/span>/.test(src));
  ok('남은 입금액 = 총비용 − 입금액 파생(0원 = 완납 표시)', /Math\.max\(tc-\(pa\|\|0\),0\)/.test(src) && src.includes("'0 ✓'"));
  ok('화면 A 컨테이너 폭 상한(1380px)', /#advHome\{max-width:1380px\}/.test(css));

  // ── 화면 B: 상세 캡 + 정산 카드 상시 펼침 + 내부 용어 미노출 ──
  ok('★ 헤더·요약 스트립·정산 카드가 본문 폭과 같은 값으로 캡(광고주 화면만)',
    /body\.advm \.main \.mh,body\.advm \.stripA,body\.advm \.setldetail,body\.advm \.wobar,body\.advm \.wodetail\{max-width:1380px\}/.test(css));
  ok('★ 원본(sot) 배지는 광고주에게 안 나간다(내부 용어)', /STATE\.role==='advertiser'\?'':sotBadge/.test(src));
  ok('정산 카드는 광고주에게 항상 펼침', /STATE\.settleOpen\|\|STATE\.role==='advertiser'\)\?'':' hidden'/.test(src));
  ok('요약 스트립 광고주 = 시작일 칸(담당자 표기 없음)', /\[\['상품',d\.productOption\|\|m\.campaignName\|\|'—'\],\['시작일'/.test(src));
  ok('★ 정산 비공개·미연결은 광고주에게 같은 안내 한 줄(계약 연결·토글 용어 미노출)',
    src.includes('정산 정보가 아직 준비되지 않았습니다'));
  ok('정산 카드 금액 4칸(_advSettleMoney): 총비용/입금액/입금일/남은 입금액', /_advSettleMoney/.test(src) && src.includes('남은 입금액') && src.includes('완납 ✓'));
  ok('발주 작업세부의 담당(내부 실명)은 광고주 미노출', /\.\.\.\(STATE\.role!=='advertiser'\?\[\['담당',d\.managerName\]\]:\[\]\)/.test(src));
  ok('Parity(내부 관측 도구) 레일탭은 광고주에게 안 그린다', /\$\{isAdv\?'':`<button class="railtab" data-rt="parity"/.test(src));

  console.log(`\n✅ advertiserViewer: ${n} cases passed`);
}

run().then(() => process.exit(0)).catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
