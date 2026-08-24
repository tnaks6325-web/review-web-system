/**
 * brandShare.test.js — 브랜드 분류·화면 공유(094) 회귀가드.
 *   시안 = frontend/docs/design-vendor-search-quotes-brands.html §3 + design-brand-header-branding.html(A안 확정).
 *
 * 고정하는 것:
 *   1. 라우터: /brands(GET) · /brands/create · /brands/update · /brands/assign 존재 + authMiddleware,
 *      **브랜드 링크 세션(brand_id 클레임)은 CRUD 403**(열람 전용), 내부 역할도 403(광고주 셀프 전용).
 *      advertiserId/brandId 는 토큰에서만(IDOR 차단).
 *   2. 서비스: 브랜드 CRUD · 배정(소유 탭 아닌 것 무시) · 삭제 시 링크 무효+배정 해제.
 *   3. 렌즈(advertiserWorkSummary): 브랜드 세션은 ① 배정 탭만 ② 정산은 업체 AND 브랜드 토글
 *      ③ folders_visible 꺼짐이면 folderUrl/captureFolderUrl 을 **서버에서 폐기**(미전송).
 *      대행사 세션엔 brands 목록 + items[].brandId 동봉.
 *   4. 문서/정산 게이트: quoteDocForTab·invoiceDocForTab·settlementForTab 이 브랜드 토글 OFF 면 hidden.
 *   5. 인증: loginByBrandToken — 유효 토큰 → brand_id/adv_name 클레임, 정지·삭제 링크는 거부.
 *   6. 프론트 배선: 브랜드 관리 메뉴(브랜드 세션 미노출), A안 운영사 표기, 미전송 칸 컬럼 제거 CSS.
 *
 * 실행: node tests/brandShare.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const jwt = require('jsonwebtoken');
const svc = require('../src/services/trackB.service');
const authSvc = require('../src/services/auth.service');
const router = require('../src/routes/trackB.routes');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}
// 소유 탭 2건(A=브랜드 배정, B=미분류) — ownedTabsForAdvertiser 응답 형태.
const ownedRows = [
  { sheetId: 's1', tabName: 'A작업', spreadsheetTitle: '시트1', tabGid: '1', bTotal: 10, bSub: 8, bPaid: 8,
    woRecruit: 20, woStartDate: '2026-05-06', folderUrl: 'https://drive/rev', captureFolderUrl: 'https://drive/buy', active: true },
  { sheetId: 's1', tabName: 'B작업', spreadsheetTitle: '시트1', tabGid: '2', bTotal: 5, bSub: 5, bPaid: 5,
    woRecruit: 5, woStartDate: '2026-06-30', folderUrl: 'https://drive/rev2', captureFolderUrl: null, active: true },
];
const brandRow = (over = {}) => ({ id: 'brd_a', advertiser_id: 'adv-1', name: '메이커스', color: '#2563eb',
  link_token: 'tokA', link_active: true, settlement_visible: false, folders_visible: false, deleted_at: null, cnt: 1, ...over });

global.fetch = async () => ({ ok: false, json: async () => ({}) });   // 인트라넷 프록시 미사용 경로만 검사

const baseRoutes = (opts = {}) => {
  const b = brandRow(opts.brand || {});
  return [
    [/WITH own AS/, () => ({ rows: ownedRows })],
    [/SELECT settlement_visible FROM trackb_advertiser_prefs/, () => ({ rows: [{ settlement_visible: opts.advVisible !== false }] })],
    [/FROM trackb_brand_tab_map WHERE advertiser_id/, () => ({ rows: [{ brandId: 'brd_a', sheetId: 's1', tabName: 'A작업' }] })],
    [/SELECT id, name, color, settlement_visible, folders_visible FROM trackb_brands/, () => ({ rows: opts.brandMissing ? [] : [b] })],
    [/SELECT b\.\*, COALESCE/, () => ({ rows: [b] })],
    [/SELECT settlement_visible FROM trackb_brands/, () => ({ rows: opts.brandMissing ? [] : [{ settlement_visible: b.settlement_visible }] })],
    [/SELECT 1 FROM trackb_brand_tab_map/, (s, p) => ({ rows: p[3] === 'A작업' ? [{ '?column?': 1 }] : [] })],
    [/SELECT id FROM trackb_brands WHERE id=\$1 AND advertiser_id=\$2/, () => ({ rows: opts.notOwned ? [] : [{ id: 'brd_a' }] })],
    [/INSERT INTO trackb_brands/, (s, p) => ({ rows: [brandRow({ id: p[0], name: p[2], color: p[3], link_token: p[4] })] })],
    [/FROM trackb_settlement_links/, () => ({ rows: [{ salesId: 'sales-1', contractNumber: 'C-1' }] })],
  ];
};

async function run() {
  /* ═══ 1. 라우터 게이트 ═══ */
  const layers = router.stack.filter(l => l.route).map(l => ({ path: l.route.path, methods: Object.keys(l.route.methods),
    mw: l.route.stack.map(s => s.name), handler: l.route.stack[l.route.stack.length - 1].handle }));
  for (const [p, m] of [['/brands', 'get'], ['/brands/create', 'post'], ['/brands/update', 'post'], ['/brands/assign', 'post']]) {
    const r = layers.find(l => l.path === p && l.methods.includes(m));
    ok(`${m.toUpperCase()} ${p} 라우트가 등록돼 있다`, !!r);
    ok(`${p} 는 authMiddleware 뒤(무인증 차단)`, r.mw.includes('authMiddleware'));
  }
  const call = async (p, admin, body = {}) => {
    const l = layers.find(x => x.path === p);
    let code = 200, out = null;
    const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
    await l.handler({ admin, query: {}, body }, res, (e) => { throw e; });
    return { code, body: out };
  };
  svc.__setPoolForTest(pool(baseRoutes()));
  for (const role of ['master', 'admin', 'staff']) {
    ok(`${role} 는 /brands 403(광고주 셀프 전용)`, (await call('/brands', { role, name: 'x' })).code === 403);
  }
  ok('advertiser_id 없는 광고주는 403', (await call('/brands', { role: 'advertiser', name: 'x' })).code === 403);
  ok('★ 브랜드 링크 세션(brand_id)은 /brands 403(열람 전용 — CRUD 도달 불가)',
    (await call('/brands', { role: 'advertiser', name: 'b', advertiser_id: 'adv-1', brand_id: 'brd_a' })).code === 403);
  ok('★ 브랜드 링크 세션은 배정(/brands/assign)도 403',
    (await call('/brands/assign', { role: 'advertiser', name: 'b', advertiser_id: 'adv-1', brand_id: 'brd_a' }, { brandId: 'brd_a', tabs: [] })).code === 403);
  const okRes = await call('/brands', { role: 'advertiser', name: '어니스트캄', advertiser_id: 'adv-1' });
  ok('대행사(광고주 본세션)는 ok:true + brands 배열', okRes.code === 200 && okRes.body.ok === true && Array.isArray(okRes.body.brands));

  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  const seg = routeSrc.slice(routeSrc.indexOf('function _advSelf'), routeSrc.indexOf('function _advSelf') + 400);
  ok('★ _advSelf: advertiser_id 는 토큰에서만 + brand_id 있으면 거부(IDOR·권한상승 차단)',
    seg.includes('a.advertiser_id') && seg.includes('a.brand_id') && !/req\.(query|body)\.advertiserId/.test(seg));
  const wsSeg = routeSrc.slice(routeSrc.indexOf("'/my-work-summary'"), routeSrc.indexOf("'/my-work-summary'") + 800);
  ok('★ my-work-summary 의 brandId 도 토큰에서만', wsSeg.includes('req.admin.brand_id') && !/req\.(query|body)\.brandId/.test(wsSeg));
  ok('★ _ensureThreadScope 가 브랜드 세션 탭을 brandTabAllowed 로 재검증(타 브랜드 작업 차단)',
    /brand_id[\s\S]{0,240}brandTabAllowed/.test(routeSrc));

  /* ═══ 2. 서비스 CRUD·배정 ═══ */
  let p2 = pool(baseRoutes()); svc.__setPoolForTest(p2);
  const cr = await svc.createBrand({ advertiserId: 'adv-1', name: '  메이커스  ', color: 'bad-color' });
  const ins = p2.q.find(x => /INSERT INTO trackb_brands/.test(x.s));
  ok('createBrand: 이름 trim + 잘못된 색상은 기본색 폴백 + 링크 토큰 발급',
    ins.params[2] === '메이커스' && ins.params[3] === '#2563eb' && typeof ins.params[4] === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(ins.params[4]));   // 링크 토큰 = _linkToken() base64url 16자(96비트) 이상
  ok('createBrand: 빈 이름 거부', (await svc.createBrand({ advertiserId: 'adv-1', name: '  ' })).code === 400);
  ok('★ 남의 브랜드 수정 불가(advertiser_id 스코프)',
    (await (async () => { svc.__setPoolForTest(pool(baseRoutes({ notOwned: true }))); return svc.updateBrand({ advertiserId: 'adv-1', brandId: 'brd_x', action: 'rename', name: 'z' }); })()).code === 404);

  p2 = pool(baseRoutes()); svc.__setPoolForTest(p2);
  await svc.updateBrand({ advertiserId: 'adv-1', brandId: 'brd_a', action: 'delete' });
  ok('★ 브랜드 삭제 = soft delete + 링크 비활성 + 배정 해제(공유 즉시 차단)',
    p2.q.some(x => /UPDATE trackb_brands SET deleted_at=NOW\(\), link_active=FALSE/.test(x.s))
    && p2.q.some(x => /DELETE FROM trackb_brand_tab_map WHERE brand_id/.test(x.s)));

  p2 = pool(baseRoutes()); svc.__setPoolForTest(p2);
  const rot = await svc.updateBrand({ advertiserId: 'adv-1', brandId: 'brd_a', action: 'link-rotate' });
  ok('링크 재발급 = 새 토큰 + 활성화(유출 대응)', rot.ok === true && typeof rot.linkToken === 'string' && rot.linkToken !== 'tokA');

  p2 = pool(baseRoutes()); svc.__setPoolForTest(p2);
  const asg = await svc.assignBrandTabs({ advertiserId: 'adv-1', brandId: 'brd_a',
    tabs: [{ sheetId: 's1', tabName: 'A작업' }, { sheetId: 'OTHER', tabName: '남의탭' }] });
  ok('★ 배정은 소유 탭만 — 소유 아닌 탭은 조용히 무시(타 업체 작업 배정 불가)', asg.ok === true && asg.assigned === 1);
  ok('배정은 전체 교체(빠진 탭 = 해제)', p2.q.some(x => /DELETE FROM trackb_brand_tab_map WHERE brand_id=\$1/.test(x.s)));

  /* ═══ 3. advertiserWorkSummary 렌즈 ═══ */
  svc.__setPoolForTest(pool(baseRoutes()));
  const agency = await svc.advertiserWorkSummary({ advertiserId: 'adv-1' });
  ok('대행사 세션: 전체 소유 탭 + brands 목록 + items[].brandId 동봉',
    agency.items.length === 2 && Array.isArray(agency.brands) && agency.items[0].brandId === 'brd_a' && agency.items[1].brandId === null);
  ok('대행사 세션은 brand=null', agency.brand === null);

  svc.__setPoolForTest(pool(baseRoutes()));
  const brandSess = await svc.advertiserWorkSummary({ advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('★ 브랜드 세션: 배정 탭만(미분류 작업 미노출)', brandSess.items.length === 1 && brandSess.items[0].tabName === 'A작업');
  ok('브랜드 세션: brand 메타(이름·색) 동봉', brandSess.brand && brandSess.brand.name === '메이커스');
  ok('★ 정산 기본 숨김(브랜드 토글 OFF) — 업체 토글이 켜져 있어도 AND 로 차단',
    brandSess.settlementHidden === true && brandSess.items[0].settlement === null);
  ok('★ 폴더 URL 은 folders_visible OFF 면 서버에서 폐기(미전송 — 프론트 숨김 아님)',
    brandSess.items[0].folderUrl === null && brandSess.items[0].captureFolderUrl === null
    && !JSON.stringify(brandSess).includes('drive/buy'));

  svc.__setPoolForTest(pool(baseRoutes({ brand: { settlement_visible: true, folders_visible: true } })));
  const openSess = await svc.advertiserWorkSummary({ advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('토글 ON: 폴더 URL 전달', openSess.items[0].folderUrl === 'https://drive/rev' && openSess.items[0].captureFolderUrl === 'https://drive/buy');
  ok('토글 ON: settlementHidden=false(정산 계산 경로 진입)', openSess.settlementHidden === false);

  svc.__setPoolForTest(pool(baseRoutes({ advVisible: false, brand: { settlement_visible: true } })));
  const advOff = await svc.advertiserWorkSummary({ advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('★ 업체 토글 OFF 면 브랜드 토글이 켜져 있어도 정산 숨김(상위 게이트 우선)', advOff.settlementHidden === true);

  svc.__setPoolForTest(pool(baseRoutes({ brandMissing: true })));
  const gone = await svc.advertiserWorkSummary({ advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('★ 삭제된 브랜드 링크 = 빈 화면(fail-closed)', gone.items.length === 0 && gone.settlementHidden === true);

  /* ═══ 4. 문서·정산 게이트 ═══ */
  svc.__setPoolForTest(pool(baseRoutes()));   // 브랜드 settlement_visible=false
  const qd = await svc.quoteDocForTab({ sheetId: 's1', tabName: 'A작업', role: 'advertiser', advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('★ 브랜드 정산 토글 OFF = 견적서 hidden', qd.hidden === true && !qd.versions);
  svc.__setPoolForTest(pool(baseRoutes()));
  const id2 = await svc.invoiceDocForTab({ sheetId: 's1', tabName: 'A작업', role: 'advertiser', advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('★ 브랜드 정산 토글 OFF = 계산서 hidden', id2.hidden === true && !id2.records);
  svc.__setPoolForTest(pool(baseRoutes()));
  const st = await svc.settlementForTab({ sheetId: 's1', tabName: 'A작업', role: 'advertiser', advertiserId: 'adv-1', brandId: 'brd_a' });
  ok('★ 브랜드 정산 토글 OFF = 정산 카드 hidden', st.hidden === true);

  /* ═══ 5. 브랜드 링크 로그인 ═══ */
  const authPool = (rows) => ({ async query() { return { rows }; } });
  const good = await authSvc.loginByBrandToken('tokA', authPool([
    { id: 'brd_a', name: '메이커스', advertiser_id: 'adv-1', advertiser_name: '어니스트캄', advertiser_status: 'active' }]));
  ok('브랜드 토큰 교환 성공 → advertiser 역할 JWT', good.success === true && good.role === 'advertiser');
  const claims = jwt.verify(good.token, process.env.JWT_SECRET);
  ok('★ JWT 에 brand_id + adv_name(A안 운영사 표기) 클레임', claims.brand_id === 'brd_a' && claims.adv_name === '어니스트캄' && claims.via === 'brand-link');
  ok('★ 브랜드 세션 name = 브랜드명(대행사명 아님)', claims.name === '메이커스' && claims.advertiser_id === 'adv-1');
  ok('정지·삭제된 링크는 거부', (await authSvc.loginByBrandToken('tokX', authPool([]))).success === false);
  ok('종료 거래처는 거부', (await authSvc.loginByBrandToken('tokA', authPool([
    { id: 'brd_a', name: 'x', advertiser_id: 'adv-1', advertiser_name: 'y', advertiser_status: 'ended' }]))).success === false);
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'auth.service.js'), 'utf8');
  ok('브랜드 링크는 광고주 링크와 같은 교환 경로(loginByLinkToken 폴백)', /loginByBrandToken\(tok, _pool\)/.test(authSrc));
  ok('브랜드 링크 조회는 link_active + deleted_at 조건(폐기 즉시 무효)',
    /link_token = \$1 AND b\.link_active = TRUE AND b\.deleted_at IS NULL/.test(authSrc));

  /* ═══ 6. 프론트 배선 ═══ */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  ok('브랜드 관리 사이드바 메뉴 — 브랜드 세션에는 미노출', /STATE\.brandId\?'':`<div class="awitem\$\{[^`]*advHome\('brands'\)/.test(src));
  ok('브랜드 관리 화면 렌더러(_renderAdvBrands) + 카드/토글', src.includes('function _renderAdvBrands') && src.includes('brdcard') && src.includes("brandFlag("));
  ok('작업 귀속 모달(체크박스 일괄 지정)', src.includes('function brandAssignModal') && src.includes('function brandAssignSave'));
  ok('브랜드 링크 = 기존 #adv= 프래그먼트 재사용', /_brandLinkUrl[\s\S]{0,160}#adv=/.test(src));
  ok('★ A안: 브랜드 화면 상단·헤더에 운영사(대행사) 표기', src.includes('function _brandBadge') && src.includes('운영: '));
  ok('★ 미전송 칸은 컬럼째 제거(자리 남기면 "미연결"로 오해)',
    src.includes('body.brandv.nostl .awlrow>span:nth-child(n+6)') && src.includes('body.brandv.nofol .awlrow>span:nth-child(5)'));
  ok('브랜드 세션 폴더 셀은 자리도 없음', /STATE\.brandId&&!it\.folderUrl&&!it\.captureFolderUrl\) return ''/.test(src));
  ok('세션 초기화 시 브랜드 상태·body 클래스 정리(계정 전환 잔재 차단)',
    src.includes("brandId:null,advName:''") && src.includes("remove('advm','brandv','nostl','nofol')"));


  /* ═══ 7. 브랜드 관리 화면 — 즉시 반영 · 귀속 어휘 · 행 펼침 (사용자 확정 2026-08-24) ═══
     ★ 문자열 검사만으로는 "함수 안 어디에 있나"를 못 본다 → 함수를 vm 으로 꺼내 **실제 실행**한다. */
  const vm = require('vm');
  const grab = (name, kind) => {   // 함수 선언 한 개를 중괄호 매칭으로 잘라낸다
    const head = (kind === 'async' ? 'async function ' : 'function ') + name + '(';
    const i = src.indexOf(head); assert(i >= 0, '함수 없음: ' + name);
    let j = src.indexOf('{', i), d = 0;
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    throw new Error('중괄호 불균형: ' + name);
  };
  const brandSandbox = (opts = {}) => {
    const box = {
      STATE: opts.STATE || {}, toasts: [], renders: 0, sidebars: 0, opened: [],
      esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      api: opts.api || (async () => ({ ok: true })),
      toast(m) { box.toasts.push(m); },
      _renderAdvBrands() { box.renders++; },
      _renderAdvSidebar() { box.sidebars++; },
      selTab(i) { box.opened.push(i); },
      _awTabIdx: (it) => (it && it.idx != null ? it.idx : -1),
      _awStatus: () => ({ label: '진행중', tone: 'b' }),
      _awDate: (it) => it.date || '8/1',
      _tabLabel: (it) => it.tabName,
      _tabTip: (it) => it.tabName,
      _bnColor: () => '#2563eb',
    };
    vm.createContext(box);
    box.$ = (sel) => (box.dom && box.dom[sel]) || null;
    for (const [nm, kd] of [['_brandOpen'], ['brandToggleRows'], ['_brandRowsHtml'], ['_brandsMerge'],
      ['_awItems'], ['_bmList'], ['_bmCell'], ['_bmEditHtml'], ['bmEdit'], ['bmClose'], ['bmInput'],
      ['_brandsReload', 'async'], ['brandNewSubmit', 'async'], ['bmSave', 'async']]) vm.runInContext(grab(nm, kd), box);
    return box;
  };

  // 7-1. 추가 성공 → **요약 재조회가 실패해도** 목록에 즉시 남는다(신고 증상의 직접 재현)
  {
    const b = brandSandbox({
      STATE: { advWork: { items: [], brands: [] }, brandNew: { open: true, name: '웰스앤헬스' }, advView: 'brands' },
      api: async (path) => path.indexOf('/brands/create') >= 0
        ? { ok: true, brand: { id: 'brd_new', name: '웰스앤헬스', color: '#2563eb', linkToken: 't', linkActive: true } }
        : null,   // ← my-work-summary 는 실패(무거운 요약 API 가 느리거나 죽은 상황)
    });
    await b.brandNewSubmit();
    await new Promise((r) => setTimeout(r, 0));   // 재조회는 배경 — 한 틱 뒤 결과(고지 토스트)를 본다
    const list = b.STATE.advWork.brands;
    ok('★ 추가 즉시 반영 — 요약 재조회가 실패해도 새 브랜드가 목록에 남는다',
      list.length === 1 && list[0].id === 'brd_new' && list[0].name === '웰스앤헬스');
    ok('★ 추가 직후 목록·사이드바를 그 자리에서 다시 그린다(재조회를 기다리지 않는다)', b.renders >= 1 && b.sidebars >= 1);
    ok('새 브랜드의 tabCount 는 0(서버가 안 준 값을 지어내지 않는다)', list[0].tabCount === 0);
    ok('★ 재조회 실패는 조용히 넘기지 않고 문장으로 말한다', b.toasts.some((t) => /불러오지 못했습니다/.test(t)));
    ok('추가 성공 자체도 알린다', b.toasts.some((t) => /추가됨/.test(t)));
    ok('입력칸은 열린 채 비워진다(연달아 등록)', b.STATE.brandNew.open === true && !b.STATE.brandNew.name);
  }
  // 7-2. 화면 중복검사는 즉시 반영된 목록을 본다 → 같은 이름 재입력은 왕복 없이 막힌다
  {
    const b = brandSandbox({
      STATE: { advWork: { items: [], brands: [{ id: 'brd_new', name: '웰스앤헬스' }] }, brandNew: { open: true, name: '웰스앤헬스' } },
      api: async () => { throw new Error('서버에 닿으면 안 된다'); },
    });
    await b.brandNewSubmit();
    ok('★ 즉시 반영 덕에 같은 이름 재추가는 서버 왕복 없이 화면에서 막힌다',
      /이미 "웰스앤헬스" 브랜드가 있습니다/.test(b.STATE.brandNew.err || ''));
  }
  // 7-3. 재조회가 브랜드를 "모른다"고 지우지 않는다
  {
    const b = brandSandbox({
      STATE: { advWork: { items: [], brands: [{ id: 'brd_a', name: '봉구' }] }, advView: 'brands' },
      api: async () => ({ ok: true, items: [] }),   // brands 미동봉(서버 브랜드 조회 실패 = undefined)
    });
    const fresh = await b._brandsReload();
    ok('★ 요약에 brands 가 없으면(모름) 기존 목록을 유지한다 — 있던 브랜드가 사라지지 않는다',
      b.STATE.advWork.brands.length === 1 && b.STATE.advWork.brands[0].id === 'brd_a' && fresh === true);
  }
  {
    const b = brandSandbox({
      STATE: { advWork: { items: [], brands: [{ id: 'brd_a', name: '봉구' }] }, advView: 'brands' },
      api: async () => ({ ok: true, items: [{ sheetId: 's1', tabName: 'A' }], brands: [] }),
    });
    await b._brandsReload();
    ok('빈 배열로 내려오면 그대로 반영한다(진짜 0건 = 지운다)', b.STATE.advWork.brands.length === 0);
  }
  // 7-4. 행 펼침 — 귀속된 작업만, 닫힘/편집 중에는 안 그린다
  {
    const items = [
      { sheetId: 's1', tabName: '웰스앤헬스 천기', brandId: 'brd_a', idx: 3, total: 10, submitted: 4 },
      { sheetId: 's2', tabName: '남의 작업', brandId: 'brd_b', idx: 4 },
      { sheetId: 's3', tabName: '미분류 작업', brandId: null, idx: 5 },
    ];
    const b = brandSandbox({ STATE: { advWork: { items, brands: [] }, brandOpen: null } });
    const brand = { id: 'brd_a', name: '웰스앤헬스' };
    ok('닫힌 브랜드는 펼침 블록을 그리지 않는다', b._brandRowsHtml(brand, items, null) === '');
    b.brandToggleRows('brd_a');
    const html = b._brandRowsHtml(brand, items, null);
    ok('★ 펼치면 그 브랜드에 귀속된 작업만 나온다(남의 작업·미분류 제외)',
      html.indexOf('웰스앤헬스 천기') >= 0 && html.indexOf('남의 작업') < 0 && html.indexOf('미분류 작업') < 0);
    ok('행을 누르면 그 작업이 열린다(selTab — 사이드바와 같은 경로)', /onclick="selTab\(3\)"/.test(html));
    ok('편집·확인 중인 카드는 펼침을 접는다(카드 모양이 통째로 바뀐다)',
      b._brandRowsHtml(brand, items, { id: 'brd_a', mode: 'rename' }) === '');
    ok('★ 귀속 0건이면 "없다"가 아니라 다음 행동을 말한다',
      /귀속된 작업이 없습니다/.test(b._brandRowsHtml({ id: 'brd_z' }, items, null)) === false
      && (b.brandToggleRows('brd_z'), /귀속된 작업이 없습니다[\s\S]*작업 귀속/.test(b._brandRowsHtml({ id: 'brd_z' }, items, null))));
    b.brandToggleRows('brd_a');
    ok('다시 누르면 접힌다(브랜드마다 독립 토글)', b._brandRowsHtml(brand, items, null) === '' && b._brandOpen('brd_z') === true);
  }
  // 7-5. 어휘 — 브랜드 관리 화면에서 "배정"은 쓰지 않는다(사용자 확정: 귀속)
  {
    const from = src.indexOf('function _renderAdvBrands'), to = src.indexOf('async function brandAssignSave');
    assert(from > 0 && to > from);
    const seg = src.slice(from, to).replace(/^\s*\/\/.*$/gm, '');   // 주석 제외
    ok('★ 브랜드 관리 화면 문구에 "배정" 없음', seg.indexOf('배정') < 0);
    ok('버튼·설명은 "귀속"', /작업 귀속<\/button>/.test(seg) && /작업 \$\{b\.tabCount\|\|0\}건 귀속/.test(seg) && /귀속됨/.test(seg));
  }
  // 7-6. 행 클릭이 버튼·토글을 삼키지 않는다
  ok('★ 카드 행 클릭 = 펼침, 버튼 묶음·토글은 stopPropagation 으로 분리',
    /brandToggleRows\('\$\{esc\(b\.id\)\}'\)/.test(src)
    && /class="brdacts" onclick="event\.stopPropagation\(\)"/.test(src)
    && (src.match(/onclick="event\.stopPropagation\(\);brandFlag\(/g) || []).length === 2);
  ok('세션 초기화에 펼침 상태도 포함(계정 전환 잔재 차단)', /brandOpen:null/.test(src));
  ok('★ 브랜드 관리는 작업 0건·요약 실패여도 열린다(막다른 길 금지 — 조기 반환보다 앞)',
    src.indexOf("if(v==='brands'&&!STATE.brandId) return _renderAdvBrands();") > 0
    && src.indexOf("if(v==='brands'&&!STATE.brandId) return _renderAdvBrands();") < src.indexOf("'진행 중인 작업이 없습니다.'}</div>`; return; }"));


  /* ═══ 8. 브랜드 담당자(135) — 작업(탭) 단위 · 최대 2명 · 라벨 없는 자유입력 (사용자 확정 2026-08-24) ═══ */
  // 8-1. 정규화 단일 출처
  {
    const norm = svc._normBrandManagers;
    ok('정규화: 공백 정리 · 빈 값 제거 · 최대 2명',
      JSON.stringify(norm(['  박가람   차장 ', '', '개똥이밥먹어', '세번째'])) === JSON.stringify(['박가람 차장', '개똥이밥먹어']));
    ok('정규화: 배열이 아니면 빈 배열(모르는 입력을 지어내지 않는다)',
      norm(null).length === 0 && norm('박가람').length === 0);
    ok('정규화: 이름은 20자 상한', norm(['가'.repeat(50)])[0].length === 20);
  }
  // 8-2. 저장 — 소유 탭만(남의 작업에 담당자를 심을 수 없다) + 빈 값이면 행 삭제
  {
    const owned = [/WITH own AS/, () => ({ rows: [{ sheetId: 's1', tabName: 'A작업', tabGid: '1' }] })];
    let p2 = pool([owned]); svc.__setPoolForTest(p2);
    const bad = await svc.setTabBrandManagers({ advertiserId: 'adv-1', sheetId: 's1', tabName: '남의작업', names: ['x'] });
    ok('★ 소유 탭이 아니면 404 + 쓰기 0건',
      bad.ok === false && bad.code === 404 && !p2.q.some(x => /INSERT INTO trackb_tab_brand_managers/.test(x.s)));
    p2 = pool([owned]); svc.__setPoolForTest(p2);
    const good = await svc.setTabBrandManagers({ advertiserId: 'adv-1', sheetId: 's1', tabName: 'A작업', names: ['박가람 차장', '개똥이밥먹어', '셋째'], actor: '어니스트캄' });
    const ins = p2.q.find(x => /INSERT INTO trackb_tab_brand_managers/.test(x.s));
    ok('저장은 upsert 1회 + 서버가 정규화한 값을 돌려준다',
      good.ok === true && ins && JSON.parse(ins.params[3]).length === 2 && good.managers[0] === '박가람 차장');
    ok('★ 쓰기 표면은 그 표 하나(운영 테이블 무접촉)',
      !p2.q.some(x => /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+(?!trackb_tab_brand_managers)/i.test(x.s)));
    p2 = pool([owned]); svc.__setPoolForTest(p2);
    const cleared = await svc.setTabBrandManagers({ advertiserId: 'adv-1', sheetId: 's1', tabName: 'A작업', names: ['  ', ''] });
    ok('★ 빈 값은 행을 지운다 — "미입력"은 행 없음 하나로만 표현한다',
      cleared.ok === true && cleared.managers.length === 0
      && p2.q.some(x => /DELETE FROM trackb_tab_brand_managers/.test(x.s))
      && !p2.q.some(x => /INSERT INTO trackb_tab_brand_managers/.test(x.s)));
  }
  // 8-3. 조회는 fail-soft(신규 표 미적용이어도 화면이 뜬다)
  {
    svc.__setPoolForTest({ async query() { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; } });
    ok('★ 표가 없어도 조회는 빈 값(fail-soft — 담당자만 안 보이고 화면은 그대로)',
      (await svc.tabBrandManagersMap({ advertiserId: 'adv-1' })).size === 0
      && (await svc.tabBrandManagersFor({ advertiserId: 'adv-1', sheetId: 's1', tabName: 'A작업' })).length === 0);
    svc.__setPoolForTest(pool([[/WITH own AS/, () => ({ rows: [{ sheetId: 's1', tabName: 'A작업' }] })]]));
  }
  // 8-4. 라우터 — 브랜드 CRUD 와 같은 게이트(브랜드 링크 세션은 도달 불가)
  {
    const l = layers.find(x => x.path === '/brands/tab-manager');
    ok('POST /brands/tab-manager 등록 + authMiddleware', !!l && l.methods.includes('post') && l.mw.includes('authMiddleware'));
    ok('★ 브랜드 링크 세션은 담당자를 못 고친다(열람 전용)',
      (await call('/brands/tab-manager', { role: 'advertiser', name: 'b', advertiser_id: 'adv-1', brand_id: 'brd_a' }, { sheetId: 's1', tabName: 'A작업', names: [] })).code === 403);
    for (const role of ['master', 'admin', 'staff']) {
      ok(`${role} 도 403(업체 셀프 창구)`,
        (await call('/brands/tab-manager', { role, name: 'x', advertiser_id: 'adv-1' }, { sheetId: 's1', tabName: 'A작업', names: [] })).code === 403);
    }
    const wd = layers.find(x => x.path === '/workdesk');
    const rsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
    const wseg = rsrc.slice(rsrc.indexOf("router.get('/workdesk'"), rsrc.indexOf("router.get('/workdesk'") + 1200);
    ok('★ /workdesk 는 brandId 를 **토큰에서만** 넘긴다(IDOR 차단)',
      !!wd && /brandId: \(req\.admin && req\.admin\.brand_id\) \|\| null/.test(wseg) && !/req\.(query|body)\.brandId/.test(wseg));
  }
  // 8-5. 렌즈 — 브랜드 세션은 내부 담당을 통째로 폐기
  {
    const lens = svc.__condAdvertiserLensForTest;
    const cd = { manager: { ae: '김수만', adminNick: '망고', adminRaw: '박은비', brand: ['박가람 차장'] } };
    const br = lens(cd, { brandSession: true });
    ok('★★ 브랜드사 화면: 내부 담당(AE·관리자)은 이름도 존재 여부도 안 나간다',
      br.manager.ae === null && br.manager.adminNick === null && br.manager.adminRaw === null
      && JSON.stringify(br.manager.brand) === JSON.stringify(['박가람 차장']));
    const ag = lens(cd, { brandSession: false });
    ok('대행사 세션: 내부 담당은 종전대로(실명만 폐기) + 업체 담당 병기',
      ag.manager.ae === '김수만' && ag.manager.adminNick === '망고' && ag.manager.adminRaw === null
      && ag.manager.brand.length === 1);
    const noBrand = lens({ manager: { ae: null, adminNick: null, adminRaw: null, brand: [] } }, { brandSession: true });
    ok('★ 미입력 브랜드사 화면은 재료가 통째로 비어 화면이 담당 행을 안 그린다',
      noBrand.manager.ae === null && noBrand.manager.adminNick === null && noBrand.manager.brand.length === 0);
  }
  // 8-6. 화면 — 작업 행 인라인 입력(vm 실행)
  {
    const items = [{ sheetId: 's1', tabName: 'A작업', brandId: 'brd_a', idx: 1, brandManagers: ['박가람 차장'] },
                   { sheetId: 's2', tabName: 'B작업', brandId: 'brd_a', idx: 2, brandManagers: [] }];
    const b = brandSandbox({
      STATE: { advWork: { items, brands: [] }, brandOpen: { brd_a: true }, bmEdit: null },
      api: async () => ({ ok: true, managers: ['박가람 차장', '개똥이밥먹어'] }),
    });
    const html = b._brandRowsHtml({ id: 'brd_a' }, items, null);
    ok('★ 담당자 칸이 행마다 있다 — 값이 있으면 이름, 없으면 입력 유도',
      html.indexOf('박가람 차장') >= 0 && html.indexOf('＋ 담당자') >= 0);
    ok('★ onclick 은 인덱스만(작업명·시트ID 보간 0)',
      /bmEdit\(0\)/.test(html) && /bmEdit\(1\)/.test(html) && html.indexOf("bmEdit('s1'") < 0);
    ok('★ 담당자 칸은 행 클릭(작업 열기)과 분리된다', /event\.stopPropagation\(\);bmEdit\(/.test(html));
    b.bmEdit(1);
    const edited = b._brandRowsHtml({ id: 'brd_a' }, items, null);
    ok('누르면 그 행 아래에서 입력칸 2개가 펼쳐진다(팝업 없음)',
      (edited.match(/<input /g) || []).length === 2 && /최대 2명/.test(edited));
    b.bmInput(0, '박가람 차장'); b.bmInput(1, '개똥이밥먹어');
    const before = b.renders;
    ok('★ 타이핑은 재렌더하지 않는다(한글 IME 조합 보호)', b.renders === before);
    await b.bmSave();
    ok('★ 저장하면 그 작업 행에 즉시 반영된다(재조회를 기다리지 않는다)',
      JSON.stringify(items[1].brandManagers) === JSON.stringify(['박가람 차장', '개똥이밥먹어'])
      && b.STATE.bmEdit === null && b.toasts.some((t) => /담당자를 저장/.test(t)));
    // 저장 실패는 입력을 지우지 않는다
    const b2 = brandSandbox({
      STATE: { advWork: { items, brands: [] }, brandOpen: { brd_a: true }, bmEdit: null },
      api: async () => ({ ok: false, error: 'not_ready' }),
    });
    b2.bmEdit(0); b2.bmInput(0, '박가람 차장'); await b2.bmSave();
    ok('★ 저장 실패 시 입력을 지우지 않고 사유를 말한다',
      b2.STATE.bmEdit && b2.STATE.bmEdit.names[0] === '박가람 차장' && /준비되지 않았습니다/.test(b2.STATE.bmEdit.err));
  }
  ok('세션 초기화에 담당자 편집 상태도 포함', /bmEdit:null/.test(src));

  console.log(`\n✅ brandShare: ${n} cases passed`);
}
run().then(() => process.exit(0)).catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
