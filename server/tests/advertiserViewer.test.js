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
  bTotal: 675, bSub: 651, bPaid: 651, manager: '만두', recruitTotal: 800, woRecruit: 750, woStartDate: '2026-04-21',
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
  ok('업체 항목은 총건수·제출·입금·시작일만 동봉(활성 작업행 수 미노출)',
    it.total === undefined && it.submitted === 651 && it.paid === 651 && it.target === 800 && it.startDate === '2026-04-21');
  ok('업체 총건수는 활성 작업행·발주보다 공고 모집 정원을 우선한다', it.target === 800 && it.target !== ownedRow.bTotal && it.target !== ownedRow.woRecruit);
  const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
  ok('업체 작업목록 제출 수는 제출 플래그가 아닌 작업표 리뷰제출 셀을 집계한다',
    /submit_header\.submit_header/.test(svcSrc)
    && /cp\.row_json\s*->>\s*COALESCE\(NULLIF\(BTRIM\(cp\.submit_col\), ''\), submit_header\.submit_header\)/.test(svcSrc)
    && /FROM participant_edits e/.test(svcSrc)
    && /cp\.anchor_count = 1/.test(svcSrc)
    && !/COUNT\(\*\) FILTER \(WHERE cp\.active AND cp\.deleted_at IS NULL AND cp\.is_submitted\)::int AS submitted/.test(svcSrc));
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
  ok('업체용 시트도 헤더와 전체 작업보드의 최장 표시값으로 열 폭을 자동 계산한다',
    /function _gridAutoColumnWidths\(wd,cols\)/.test(src)
    && /STATE\.gColWidths=_gridAutoColumnWidths\(wd,vcols\)/.test(src));
  ok('업체용 시트 값은 줄바꿈·말줄임 없이 셀 너비 안에서 한 줄로 표시한다',
    /table\.sheetgrid\.advsnug td\{[^}]*white-space:nowrap[^}]*overflow:hidden[^}]*text-overflow:clip[^}]*overflow-wrap:normal[^}]*word-break:normal/.test(css));

  const iQhd = css.indexOf('body[data-vw="qhd"]'), iAdv = css.indexOf('body.advm{--app-max:1680px}'), iWide = css.indexOf('body.widemode{--app-max:100vw}');
  ok('★ body.advm 상한(1680px)이 존재한다', iAdv > -1);
  ok('★ 선언 순서: data-vw 뒤(광고주 고정이 이김) · widemode 앞(전체화면은 해제)', iQhd > -1 && iWide > -1 && iQhd < iAdv && iAdv < iWide);
  ok('renderShell 이 광고주일 때 body.advm 을 붙인다', /classList\.toggle\('advm',\s*isAdv\)/.test(src));
  ok('renderLogin 이 advm 잔재를 제거한다(로그아웃·만료 후 원복)', /renderLogin[\s\S]{0,300}classList\.remove\('advm'/.test(src));
  ok('★ FHD/QHD 토글은 광고주에게 안 그린다', /\$\{isAdv\?'':`<div class="vwsw"/.test(src));

  // ── 작업 선택 = 좌측 세로 목록(업체관리 차용) ──
  ok('광고주 작업보드 = awside 사이드바 + advwrap 그리드(가로 탭바 없음)',
    src.includes('class="wrap advwrap') && src.includes('id="awside"') );
  ok('advwrap 3열 그리드(사이드바 224px + 본문 + 레일)', /\.wrap\.advwrap\{grid-template-columns:224px minmax\(0,1fr\) 300px\}/.test(css));
  ok('_renderTabList 광고주 분기 → _renderAdvSidebar(세그먼트/탭바 미참조) + 첫 화면 갱신',
    /if\(STATE\.role==='advertiser'\)\{ _renderAdvSidebar\(\); if\(!STATE\.cur\) _renderAdvHome\(\); return; \}/.test(src));
  ok('loadTabs 가 광고주면 /my-work-summary 를 함께 받는다', src.includes("api('/api/trackb/my-work-summary')"));

  // ── 화면 A: 내 작업 목록 표 ──
  ok('화면 A 컬럼: 시작일·진행상황·총건수/제출/입금·견적서·계산서·총비용·입금액·입금일·남은 입금액',
    /<span>시작일<\/span><span>작업명<\/span><span>진행상황<\/span><span>총건수·제출·입금<\/span><span>자료 폴더<\/span><span>견적서<\/span><span>계산서<\/span><span>총비용<\/span><span>입금액<\/span><span>입금일<\/span><span>남은 입금액<\/span>/.test(src));
  ok('남은 입금액 = 총비용 − 입금액 파생(0원 = 완납 표시)', /Math\.max\(tc-\(pa\|\|0\),0\)/.test(src) && src.includes("'0 ✓'"));
  ok('화면 A 컨테이너 폭 상한(1380px)', /#advHome\{max-width:1380px\}/.test(css));

  // ── 화면 B: 상세 캡 + 정산 카드 상시 펼침 + 내부 용어 미노출 ──
  ok('★ 헤더·요약 스트립·정산 카드가 본문 폭과 같은 값으로 캡(광고주 화면만)',
    // 상단 요약이 8칸 스트립(.stripA) → 3분할 카드(.tp3grid, 시안 B)로 바뀌며 캡 대상도 함께 옮겼다(검사 의미 불변)
    /body\.advm \.main \.mh,body\.advm \.tp3grid,body\.advm \.setldetail,body\.advm \.wobar,body\.advm \.wodetail\{max-width:1380px\}/.test(css));
  ok('★ 원본(sot) 배지는 광고주에게 안 나간다(내부 용어)', /STATE\.role==='advertiser'\?'':sotBadge/.test(src));
  ok('정산 카드는 광고주 상단 조합 안에서 항상 펼침',
    /<div class="advsettle setldetail" id="setldetail"><div id="settlementsec"><\/div><\/div>/.test(src));
  /* ⚠ 2026-08-23: 광고주 전용 4줄 요약(상품·시작일·구매시간·배송)은 폐기됐다 — 이제 내부와
     **같은 작업 조건 카드**를 쓴다(일정·구매시간이 그 카드의 행으로 들어갔다).
     ★ 담당자(내부 실명)를 안 붙인다는 규율은 그대로다 — 카드 폴백에서 고정한다. */
  ok('★ 광고주 전용 4줄 요약 사본은 없다(카드 한 벌)',
    !/\[\['상품',d\.productOption\|\|m\.campaignName\|\|'—'\],\['시작일'/.test(src));
  ok('★ 담당자 실명은 광고주에게 안 붙는다(카드 폴백)', /\(!isAdv&&m\.manager\)/.test(src));
  ok('★ 정산 비공개·미연결은 광고주에게 같은 안내 한 줄(계약 연결·토글 용어 미노출)',
    src.includes('정산 정보가 아직 준비되지 않았습니다'));
  ok('정산 카드 6칸(_advSettleFields): 견적서/계산서/총비용/입금액/입금일/남은 입금액',
    /_advSettleFields\(d,q,inv,pay\)/.test(src)
    && /<div class="k">견적서 ⧉<\/div>/.test(src) && /<div class="k">계산서 ⧉<\/div>/.test(src)
    && /<div class="k">총비용/.test(src) && /<div class="k">입금액<\/div>/.test(src)
    && /<div class="k">입금일 \(최근\)<\/div>/.test(src) && /<div class="k">남은 입금액<\/div>/.test(src)
    && src.includes('완납 ✓'));
  ok('★ 광고주 정산 카드에는 내부 스텝퍼·계약 변경/해제 버튼이 없다(6칸으로 대체)',
    /if\(!canLink\)\{[\s\S]{0,700}_advSettleFields\(d,q,inv,pay\)[\s\S]{0,80}return;\s*\}/.test(src));
  ok('발주 작업세부의 담당(내부 실명)은 광고주 미노출', /\.\.\.\(STATE\.role!=='advertiser'\?\[\['담당',d\.managerName\]\]:\[\]\)/.test(src));
  ok('Parity(내부 관측 도구) 레일탭은 광고주에게 안 그린다', /\$\{isAdv\?'':`<button class="railtab" data-rt="parity"/.test(src));

  /* ═══ 5. 첫 화면 대시보드(시안 design-advertiser-dashboard.html) ═══ */
  ok('첫 화면 기본값 = 대시보드(STATE.advView:\'dash\')', /advView:'dash'/.test(src));
  ok('_renderAdvHome 이 advView 로 대시보드/전체 작업/브랜드 관리를 분기한다',
    /if\(v==='brands'&&!STATE\.brandId\) return _renderAdvBrands\(\);/.test(src)
    && /if\(v==='list'\) _renderAdvList\(\); else _renderAdvDash\(\);/.test(src));
  ok('사이드바 상단 = [대시보드] · [전체 작업] 2줄', /onclick="advHome\('dash'\)"[\s\S]{0,120}대시보드/.test(src) && /onclick="advHome\('list'\)"[\s\S]{0,120}전체 작업/.test(src));
  ok('사이드바 작업 목록을 진행 중 / 완료 그룹으로 나눈다',
    /grp\(items\.filter\(it=>!_awDone\(it\)\),'진행 중'\)[\s\S]{0,80}grp\(items\.filter\(_awDone\),'완료'\)/.test(src));
  ok('★ 진행/완료 판정 단일 출처 _awDone(=_awStatus.done) — 사이드바·KPI·게이지가 같은 함수를 본다',
    /function _awDone\(it\)\{ return _awStatus\(it\)\.done; \}/.test(src));
  ok('업체 진행률은 제출 ÷ 총건수이며, 완료 목록에만 고정 폭 상태 배지를 둔다',
    /function _awProgress\(it\)\{[\s\S]{0,360}submitted\/target/.test(src)
    && /\.bb\.advprog\{[^}]*width:80px[^}]*justify-content:center[^}]*font-variant-numeric:tabular-nums/.test(css)
    && /\$\{st\.done\?`<span class="bb advprog \$\{st\.tone\}">\$\{esc\(st\.label\)\}<\/span>`:''\}/.test(src));
  ok('진행 중 목록에는 날짜 사각 썸네일을 두지 않고, 완료 목록에서만 표시한다',
    /\$\{st\.done\?`<span class="ava">\$\{esc\(_awDate\(it\)\)\}<\/span>`:''\}/.test(src));
  const awTargetBody = (src.match(/function _awTarget\(it\)\{[\s\S]{0,240}\n\}/) || [''])[0];
  ok('총건수 미설정 작업은 제목의 숫자를 추정값으로 쓰지 않는다',
    /Number\(it&&it\.target\)[\s\S]{0,160}Number\.isFinite\(t\)&&t>0/.test(awTargetBody)
    && !awTargetBody.includes('tabName'));
  ok('★ 정산 파생(남은 입금액=총비용−입금액) 단일 출처 _awSetl',
    /function _awSetl\(it\)\{[\s\S]{0,320}Math\.max\(tc-\(pa\|\|0\),0\)/.test(src));
  ok('★ 표 행 빌더는 한 벌(_awRowHtml) — 대시보드 최근 작업은 limit 만 달리해 재사용(사본 금지)',
    /function _awRowHtml\(it\)/.test(src)
    && /function _awListHtml\(items, limit\)/.test(src)
    && /_awListHtml\(items, RECENT\)/.test(src)
    && (src.match(/class="awlhead"/g) || []).length === 1);
  ok('KPI 4칸: 진행 중 작업 · 제출 진척 · 총 계약금액 · 미입금 잔액',
    /진행 중 작업<\/div>/.test(src) && /제출 진척 \(진행 중\)/.test(src) && /총 계약금액/.test(src) && /미입금 잔액/.test(src));
  ok('★ 정산 노출 OFF 업체는 금액 KPI·정산 패널을 통째로 뺀다(빈 0원 표시 금지)',
    /\+\(setlOn\?`<div class="adkpi"><div class="k">총 계약금액/.test(src) && /const pipe=setlOn\?/.test(src));
  ok('제출 진척은 진행 중 작업의 제출 ÷ 총건수만 집계(내부 활성 작업행 미사용)',
    /running\.forEach\(it=>\{[\s\S]{0,140}const p=_awProgress\(it\);[\s\S]{0,160}rSub\+=p\.submitted; rTgt\+=p\.target;/.test(src)
    && /!hasUnknownTotal&&rTgt\?Math\.min\(100,Math\.round\(rSub\/rTgt\*100\)\):null/.test(src)
    && /총건수 대비 제출 \$\{sPct\}%/.test(src));
  ok('총 계약금액 KPI 가 정산 미연결 건수를 부제로 고지한다(조용한 누락 금지)', /미연결 \$\{unlinked\}건/.test(src));
  ok('확인 필요 = 잔액(큰 순) → 계산서 미발행 → 미확인 코멘트, 최대 5건',
    /\.filter\(x=>x\.rest>0\)\.sort\(\(a,b\)=>b\.rest-a\.rest\)/.test(src)
    && /invoiceStatus!=='issued'/.test(src) && /_wUnseen\(i\); if\(!n\) return;/.test(src)
    && /todos\.slice\(0,5\)/.test(src));
  ok('확인 필요가 비면 안내 문구(빈 패널 금지)', src.includes('확인할 항목이 없습니다'));
  ok('★ 대시보드 클래스는 ad* 접두 — 기존 .gauge/.dgrid/.kpi 와 충돌 금지',
    /\.adkpis\{/.test(css) && /\.adgrid\{/.test(css) && /\.adgauge\{/.test(css)
    && !/(^|\})\s*\.gauge\{width:168px/.test(css) && /\.gauge\{width:44px/.test(css) && /\.dgrid\{display:grid;grid-template-columns:1fr;/.test(css));
  ok('대시보드 컨테이너 폭 상한(1380px — 목록 표와 같은 값)', /#advDash\{max-width:1380px\}/.test(css));
  ok('★ 미확인 코멘트 갱신이 대시보드까지 재렌더(확인 필요 위젯이 stale 로 남지 않게)',
    /_renderAdvSidebar\(\); if\(!STATE\.cur\) _renderAdvHome\(\);/.test(src));
  ok('★ 뒤로/앞으로가 대시보드↔전체 작업 전환을 되짚는다(히스토리 항목에 advView)',
    /e\.advView=STATE\.advView\|\|'dash'/.test(src)
    && /if\(\(a\.advView\|\|''\)!==\(b\.advView\|\|''\)\) return false;/.test(src)
    && /if\(st\.advView\) STATE\.advView=st\.advView;/.test(src));

  /* ═══ 6. 광고주 컬럼 차단 목록(_advertiserColumns) ═══ */
  const advCols = svc.__advertiserColumnsForTest;
  const advHeaderCandidates = svc.__advertiserHeaderCandidatesForTest;
  const advColumnValue = svc.__advertiserColumnValueForTest;
  ok('_advertiserColumns 가 테스트로 노출돼 있다', typeof advCols === 'function');
  ok('광고주 헤더 후보 보완기가 테스트로 노출돼 있다', typeof advHeaderCandidates === 'function');
  {
    const staleDetected = ['번호', '수취인', '쿠팡id', '연락처', '주소', '결제금액', '리뷰제출', '입금'];
    const recovered = advHeaderCandidates(staleDetected, [{ row_json: { 택배송장: '2616771000000', 은행: '비노출' } }]);
    ok('동기화가 오래된 detected_headers 에 없는 택배송장도 행 데이터 키에서 보완한다',
      advCols(recovered).includes('택배송장'));

    // 차단 목록 전환 뒤에는 리뷰제출 열 헤더가 어떤 이름이든 원본 순서대로 남는다.
    const hs = ['번호', '구매날짜', '수취인', '연락처', '주소', '결제금액', '카페/블로그 발행', '입금'];
    ok('★ 상태 칸 이름이 키워드에 안 걸려도 원본 컬럼으로 나온다',
      advCols(hs, { submitCol: '카페/블로그 발행', submitCol2: '입금' }).includes('카페/블로그 발행'));
    ok('★ 출력 순서 = 결제금액 → 리뷰제출 → 입금(사용자 요청 위치)', (() => {
      const o = advCols(hs, { submitCol: '카페/블로그 발행', submitCol2: '입금' });
      return o.indexOf('결제금액') < o.indexOf('카페/블로그 발행') && o.indexOf('카페/블로그 발행') < o.indexOf('입금');
    })());
    ok('옵션 없이 호출해도 같은 원본 컬럼이 나온다', advCols(hs).includes('카페/블로그 발행'));
    const hs2 = ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액', '리뷰제출일', '입금일자'];
    ok('★ 원본 순서를 유지해 구매일자와 입금일자가 모두 나온다', (() => {
      const o = advCols(hs2, { submitCol: '리뷰제출일', submitCol2: '입금일자' });
      return o.includes('입금일자') && o.includes('구매일자') && o.indexOf('구매일자') < o.indexOf('입금일자');
    })());
    ok('실재하지 않는 헤더를 submit_col 로 줘도 무시(빈 열 생성 금지)',
      !advCols(hs, { submitCol: '없는열' }).includes('없는열'));
    ok('opts 없이 호출한 결과는 종전과 동일(무회귀)',
      JSON.stringify(advCols(hs2)) === JSON.stringify(advCols(hs2, {})));
    ok('★ 다섯 차단 컬럼(은행·계좌·예금주)은 나오지 않는다',
      JSON.stringify(advCols(['수취인', '은행', '계좌번호', '예금주'])) === JSON.stringify(['수취인']));
  }
  ok('workdeskTab 이 보완된 헤더 후보를 광고주 차단 목록에 넘긴다',
    /_advertiserColumns\(_advertiserHeaderCandidates\(raw, roster, advEditedHeaders\)\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8')));

  /* ═══ 7. 리뷰 캡처 미리보기(행별) ═══ */
  {
    ok('\uAD11\uACE0\uC8FC \uCEEC\uB7FC \uAC12 \uD22C\uC601\uAE30\uAC00 \uD14C\uC2A4\uD2B8\uB85C \uB178\uCD9C\uB3FC \uC788\uB2E4', typeof advColumnValue === 'function');
    const trackedValue = typeof advColumnValue === 'function'
      ? advColumnValue({}, { 'col:\uD0DD\uBC30\uC1A1\uC7A5': '2616771000000' }, '\uD0DD\uBC30\uC1A1\uC7A5')
      : null;
    ok('\uD5C8\uC6A9\uB41C \uD0DD\uBC30\uC1A1\uC7A5\uC740 \uD589\uC758 \uC140 \uD3B8\uC9D1 \uAC12\uC744 \uC6D0\uBCF8 \uD589 \uAC12\uBCF4\uB2E4 \uC6B0\uC120\uD574 \uBC18\uD658\uD55C\uB2E4', trackedValue === '2616771000000');
    const fromCellEdit = advHeaderCandidates(
      ['\uBC88\uD638', '\uC218\uCDE8\uC778', '\uCFE0\uD321id', '\uC5F0\uB77D\uCC98', '\uC8FC\uC18C'],
      [],
      ['\uD0DD\uBC30\uC1A1\uC7A5', '\uC740\uD589']
    );
    ok('\uC6D0\uBCF8 \uD589\uC5D0 \uC5C6\uB294 \uD0DD\uBC30\uC1A1\uC7A5 \uC140 \uD3B8\uC9D1 \uC624\uBC84\uB808\uC774\uB3C4 \uC5C5\uCCB4 \uD5E4\uB354\uB85C \uBCF4\uC644\uD55C\uB2E4',
      advCols(fromCellEdit).includes('\uD0DD\uBC30\uC1A1\uC7A5'));
    ok('\uC140 \uD3B8\uC9D1 \uC624\uBC84\uB808\uC774\uC5D0 \uC788\uB354\uB77C\uB3C4 \uD5C8\uC6A9 \uBC16 \uC740\uD589 \uCEEC\uB7FC\uC740 \uB178\uCD9C\uD558\uC9C0 \uC54A\uB294\uB2E4',
      !advCols(fromCellEdit).includes('\uC740\uD589'));
  }

  const rvLayer = layers.find(l => l.path === '/workdesk/review-images');
  ok('GET /workdesk/review-images 라우트가 authMiddleware 뒤에 있다',
    rvLayer && rvLayer.methods.includes('get') && rvLayer.mw.includes('authMiddleware'));
  ok('★ 스코프 게이트(_ensureThreadScope) — 소유/담당 탭만(교차 열람 차단)',
    /'\/workdesk\/review-images'[\s\S]{0,420}_ensureThreadScope\(req, sheetId, tabName\)/.test(routeSrc));
  {
    svc.__setPoolForTest(pool([
      [/FROM review_submissions/, () => ({ rows: [
        { row_index: 3, file_id: 'FILEAAAAAAAAAAAAAAAAAAAA', slot_key: 'review', at: '2026-07-01T00:00:00Z' },
        { row_index: 3, file_id: 'FILEBBBBBBBBBBBBBBBBBBBB', slot_key: 'cash_receipt', at: '2026-07-01T00:01:00Z' },
        { row_index: 3, file_id: 'FILEAAAAAAAAAAAAAAAAAAAA', slot_key: 'review', at: '2026-07-02T00:00:00Z' },   // 중복 파일
        { row_index: 5, file_id: null, slot_key: 'review', at: null },                                            // 빈 파일ID
      ] })],
      [/FROM review_index/, () => ({ rows: [
        { row_index: 3, review_file_id: 'FILEAAAAAAAAAAAAAAAAAAAA', review_file_at: null },   // 이미 있는 건 중복 안 됨
        { row_index: 9, review_file_id: 'FILECCCCCCCCCCCCCCCCCCCC', review_file_at: '2026-06-01T00:00:00Z' },
      ] })],
    ]));
    const rv = await svc.reviewImagesForTab({ sheetId: 'S1', tabName: 'T' });
    ok('행별 파일 목록을 row_index 키로 반환(= 참여자 seq)', Array.isArray(rv['3']) && rv['3'].length === 2);
    ok('같은 파일ID 중복 제거', rv['3'].filter(f => f.fileId === 'FILEAAAAAAAAAAAAAAAAAAAA').length === 1);
    ok('빈 file_id 행은 키 자체가 안 생긴다', !('5' in rv));
    ok('원장(032)에 없고 대표 이미지(031)만 있는 과거 행도 폴백으로 합류', rv['9'] && rv['9'][0].fileId === 'FILECCCCCCCCCCCCCCCCCCCC');
    ok('슬롯 라벨(현금영수증 등) 동봉', rv['3'].some(f => f.slot === 'cash_receipt'));
  }
  /* ⚠ 2026-08-24: 총건수 초과 줄에 `class="gover"` 가 조건부로 붙으며 `<tr ` 뒤가 달라졌다.
     검사 의미는 그대로 — **행(tr)에 data-rid 가 실린다**(셀에만 있으면 tr 단위 선택이 죽는다). */
  ok('프론트: 그리드 행에 data-rid(선택 키)가 실린다', /<tr[^>]* data-rid="\$\{esc\(r\.id\)\}"/.test(src));
/* ★★ 업체 뷰어 상단도 **내부와 같은 3분할**(사용자 확정 2026-08-23) — 종전 세로 스택 +
   표 옆 세로 레일은 폐기했다. 이제 작업 조건 카드까지 한 벌이라, 다른 것은 정산 자리뿐이다. */
  ok('프론트: 광고주 상세도 같은 3분할 + 정산 카드 + 표(중복 rvPane 없음)',
    /<section class="advwork">\$\{summaryStrip\(wd,d,m,c\)\}<div class="advsettle setldetail" id="setldetail"><div id="settlementsec"><\/div><\/div><div class="advgw"><div id="gridhost">\$\{tableSection\}<\/div><\/div><\/section>/.test(src)
    && !/class="advtop"/.test(src)
    // id 중복은 치명적 — 미리보기 칸은 summaryStrip 이 만드는 하나뿐이다
    && (src.match(/id="rvPane"/g) || []).length === 1);
  ok('★ 상단 배치는 `.tp3grid.c3` 한 벌이 정한다(업체 전용 areas 잔재 0)',
    /\.advwork\{display:block;max-width:1380px\}/.test(css)
    && !/grid-template-areas:"top preview"/.test(css)
    && !/\.advtop\{/.test(css) && !/\.advcondition\{/.test(css) && !/\.advprogress\{/.test(css)
    && !/\.advwork \.rvpane\{grid-area:preview/.test(css));
  ok('★ 정산은 3분할 아래 별도 줄(업체 정산은 상시 펼침 6칸 — 내부의 접이식과 성질이 다르다)',
    /\.advsettle\.setldetail\{margin-bottom:12px\}/.test(css) && /\.advwork \.tp3grid\.c3\{margin-bottom:12px\}/.test(css));
  ok('★ 미리보기 렌더러는 한 벌 — 업체 세로 레일(.rvmedia/.rvasset)은 폐기',
    /function _rvRender\(\)\{\s*const pane=\$\('#rvPane'\); if\(!pane\) return;\s*return _rvRender2\(pane\);\s*\}/.test(src)
    && !/rvmedia/.test(src) && !/rvasset/.test(src) && !/_RV_SLOT/.test(src)
    && !/rvmedia/.test(css) && !/rvasset/.test(css));
  /* ★★ 2026-08-23 사용자 확정: 업체 뷰어도 **같은 작업 조건 카드**를 쓴다(종전 4줄 요약 폐기).
     무엇을 보여줄지는 **서버 렌즈**(`_condAdvertiserLens`)가 정하고 — 리뷰비·입금명·다계정·
     현금영수증·내부 식별자는 응답에 아예 없다 — 화면은 광고주에게 셋만 다르게 한다:
     ㉮ 지정 10행만 ㉯ [미설정](내부 창구 버튼) 대신 「—」 ㉰ 발주 줄 미표시(역할 게이트가 없다). */
  ok('★ 업체 뷰어도 작업 조건 카드는 **한 벌**(광고주 전용 4줄 사본 0)',
    /const cond=_condCardHtml\(wd,d,m\);/.test(src)
    && !/isAdv\s*\?\s*`<div class="tp3col"><div class="tp3t">작업 조건/.test(src));
  ok('★ 광고주에게는 발주 줄(작업오더 제목·상태·[원문])을 그리지 않는다 — 그 줄엔 역할 게이트가 없다',
    /const woRows=isAdv\?'':`\$\{_woUnlinkedRow\(wd\)\}\$\{_woLinkedRow\(wd\)\}`/.test(src)
    && !/\$\{_woUnlinkedRow\(wd\)\}\$\{_woLinkedRow\(wd\)\}<\/div>`/.test(src));
  ok('★ 광고주에게는 [미설정] 배지를 그리지 않는다(내부 창구를 여는 버튼이다)',
    /if\(isAdv\) return '<dd><span class="cnna">—<\/span><\/dd>';/.test(src));
  ok('★ 광고주 폴백(요약 없음)에도 담당자 실명을 붙이지 않는다',
    /\(!isAdv&&m\.manager\)/.test(src));
  ok('★ 지정 10행만 — 다계정·현금영수증·리뷰비·입금명은 화면에서도 뺀다', (() => {
    const m = src.match(/\.filter\(\(\[k\]\)=>!isAdv\|\|\[([^\]]*)\]\.includes\(k\)\)/);
    if (!m) return false;
    const keys = m[1];
    return /'@murl'/.test(keys) && /'@sched'/.test(keys) && /'@time'/.test(keys)
      && /'총건수'/.test(keys) && /'일건수'/.test(keys) && /'@pay'/.test(keys)
      && /'구매채널'/.test(keys) && /'유입방식'/.test(keys) && /'리뷰타입'/.test(keys)
      && !/'리뷰비'/.test(keys) && !/'입금명'/.test(keys)
      && !/'다계정'/.test(keys) && !/'현금영수증'/.test(keys);
  })());
  /* ★★ 서버 렌즈 = **화이트리스트 재구성**(스프레드 금지) — 나중에 조건 요약에 필드가 늘면
     스프레드는 그것을 조용히 광고주에게 흘린다(`_tpAdvertiserLens` 와 같은 규율). */
  ok('★ 서버 렌즈가 리뷰비·입금명·내부 식별자를 폐기한다', (() => {
    const SVC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
    const i = SVC.indexOf('function _condAdvertiserLens(');
    const blk = SVC.slice(i, SVC.indexOf('\n}', i));
    return i > 0 && !/\.\.\.cd/.test(blk)
      && !/reviewFee|feeSource|depositName|multiAccount|cashReceipt|incomeType|slotsPinned/.test(blk)
      && !/campaignId|workOrderId|campaignCount/.test(blk)
      && /productName|productUrl|schedule|purchaseWindow|recruitTotal|dailyLimit|payAmount|channel|inflowType|reviewTypeLabel/.test(blk);
  })());
  /* ★★ 담당 2인(사용자 확정 2026-08-24) — 업체 화면에도 「담당 AE팀 황운하 / 관리자 만두」.
     ★ 관리자는 **닉네임**으로만 나간다 — 실명(`adminRaw`)은 렌즈가 폐기하고, 닉네임이 없으면
       빈 문자열(= 화면이 라벨만 적음)로 fail-closed. 리뷰어 화면의 `닉네임 || '관리자'` 와 같은 규율.
     ★ **"실명은 있는데 닉네임이 없음" 과 "담당자가 없음" 을 구분**한다 — 전자를 null 로 접으면
       담당자가 없는 작업처럼 보인다. */
  ok('★ 렌즈가 관리자 실명을 지우고 fail-closed 로 완결한다', (() => {
    const SVC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
    const i = SVC.indexOf('function _condAdvertiserLens(');
    const blk = SVC.slice(i, SVC.indexOf('\n}', i));
    return i > 0
      && /adminNick: m\.adminNick \|\| \(raw \? '' : null\)/.test(blk)   // 있으면 라벨만 · 없으면 조각 자체 없음
      && /adminRaw: null/.test(blk);                                    // 실명은 절대 안 나간다
  })());
  ok('★ 담당 행이 업체 표기 항목에 들어 있다', (() => {
    const m = src.match(/\.filter\(\(\[k\]\)=>!isAdv\|\|\[([^\]]*)\]\.includes\(k\)\)/);
    return !!m && /'@mgr'/.test(m[1]);
  })());
  ok('★ 광고주 분기가 그 렌즈를 거친다(날것 `_cond` 금지)', (() => {
    const SVC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
    // ⚠ 2026-08-24: 브랜드 담당자(135)로 렌즈가 세션 종류를 받는다 — 검사 의미는 그대로(날것 금지)
    //    이고, **브랜드 세션 여부가 토큰에서 온 값으로 전달되는지**까지 함께 고정한다.
    return /res\.condition = _condAdvertiserLens\(_cond, \{ brandSession: !!brandId \}\)/.test(SVC)
      && !/res\.condition = _cond;[\s\S]{0,200}role === 'advertiser'/.test(SVC);
  })());
  ok('★ 이미지 URL 은 bare API_BASE 로 만든다(window.API_BASE_URL 은 최상위 const 라 항상 undefined)', (() => {
    const i = src.indexOf('function _rvUrl(');
    const body = src.slice(i, i + 260);
    return /API_BASE\+'\/api\/drive\/image\/'/.test(body) && !/window\.API_BASE_URL/.test(body);
  })());
  ok('파일ID 형식 검증 후에만 URL 생성(임의 문자열 주입 차단)', /\/\^\[-\\w\]\{20,\}\$\/\.test\(String\(id\|\|''\)\)/.test(src));
  ok('리뷰 팝업은 ↑← 이전 · ↓→ 다음 작성자로 이동하고, 표 행 이동과 분리한다',
    /if\(document\.getElementById\('rvpop'\)\)\{[\s\S]{0,300}ArrowUp[\s\S]{0,80}ArrowLeft[\s\S]{0,160}_rvPopStep\(-1\)[\s\S]{0,220}ArrowDown[\s\S]{0,80}ArrowRight[\s\S]{0,160}_rvPopStep\(1\)/.test(src)
    && /e\.key!=='ArrowUp'&&e\.key!=='ArrowDown'/.test(src)
    && /INPUT\|SELECT\|TEXTAREA/.test(src));
  ok('행 클릭·키 이동이 위임 1회 바인딩(재렌더로 tbody 가 갈려도 유지)', /if\(STATE\._rvBound\) return; STATE\._rvBound=true;/.test(src));
/* ★ 문구는 두 칸 렌더러(`_rvRender2`)의 것으로 바뀌었지만 **구분해 말한다**는 규칙은 그대로다
   — 미제출과 "제출 표시는 있는데 캡처가 없음"을 뭉뚱그리지 않는다. */
  ok('★ 미제출 행은 빈 칸에 "리뷰 미제출"로 사실대로 표기(경고 톤)',
    /r\.submitted\?'이미지 미등록':'리뷰 미제출'/.test(src) && /아직 리뷰가 제출되지 않았습니다\./.test(src)
    && /,\s*!r\.submitted\);/.test(src));
  ok('제출 표시는 있는데 이미지가 없는 행은 다르게 안내(사실대로)',
    /제출 표시는 있으나 캡처가 등록되지 않았습니다\./.test(src));
  // 표 검색(_gsReapply) 도입으로 뒤에 호출이 하나 더 붙었다 — 검사 의미(재렌더 끝에 선택 복원 배선)는 불변.
  ok('필터·정렬 재렌더 후 선택 복원(_rvReapply)', /_fitGrid\(\); _rvReapply\(\);/.test(src));
  ok('미리보기 패널 CSS(내부와 한 벌 — 두 칸·절대배치 레이어·미제출 안내 박스)',
    /\.tp3grid\.c3 \.rvpane\{position:relative;overflow:hidden;padding:0\}/.test(css)
    && /\.rv2\{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr/.test(css)
    && /\.rvnone\{/.test(css) && /\.sheetgrid tbody tr\.rvon>td\{/.test(css));
  ok('리뷰 캡처는 작성자 목록 팝업으로 열리고, 바깥 클릭 대신 이미지 우측 상단 닫기 버튼만 둔다',
    /function _rvOpenByImage\(el\)\{ _rvOpen\(el&&el\.dataset\.rid, \+\(el&&el\.dataset\.fidx\|\|0\)\); \}/.test(src)
    && /function _rvPopRender\(\)/.test(src)
    && /<aside class="rvplist ui-stable-vscroll">/.test(src)
    && /class="rvpclose"[^>]*onclick="_rvPopClose\(\)"/.test(src)
    // ⚠ 제출물 미리보기(2026-08-21) — 목록이 4열(번호/수취인/🛒/📷)이 되며 폭이 늘었고
    //    무대가 좌우 2분할이 됐다. 검사 의미는 불변 — 팝업은 [작성자 목록 | 무대] 2단이다.
    && /\.rvpop\{width:min\(\d+px,calc\(100vw - 56px\)\);height:min\(720px,calc\(100vh - 56px\)\);[\s\S]{0,140}grid-template-columns:\d+px minmax\(0,1fr\)/.test(css)
    && /<div class="rvpcols">/.test(src));

  console.log(`\n✅ advertiserViewer: ${n} cases passed`);
}

run().then(() => process.exit(0)).catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
