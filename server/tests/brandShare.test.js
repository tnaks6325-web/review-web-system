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
    ins.params[2] === '메이커스' && ins.params[3] === '#2563eb' && typeof ins.params[4] === 'string' && ins.params[4].length >= 20);
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
  ok('작업 배정 모달(체크박스 일괄 배정)', src.includes('function brandAssignModal') && src.includes('function brandAssignSave'));
  ok('브랜드 링크 = 기존 #adv= 프래그먼트 재사용', /_brandLinkUrl[\s\S]{0,160}#adv=/.test(src));
  ok('★ A안: 브랜드 화면 상단·헤더에 운영사(대행사) 표기', src.includes('function _brandBadge') && src.includes('운영: '));
  ok('★ 미전송 칸은 컬럼째 제거(자리 남기면 "미연결"로 오해)',
    src.includes('body.brandv.nostl .awlrow>span:nth-child(n+6)') && src.includes('body.brandv.nofol .awlrow>span:nth-child(5)'));
  ok('브랜드 세션 폴더 셀은 자리도 없음', /STATE\.brandId&&!it\.folderUrl&&!it\.captureFolderUrl\) return ''/.test(src));
  ok('세션 초기화 시 브랜드 상태·body 클래스 정리(계정 전환 잔재 차단)',
    src.includes("brandId:null,advName:''") && src.includes("remove('advm','brandv','nostl','nofol')"));

  console.log(`\n✅ brandShare: ${n} cases passed`);
}
run().then(() => process.exit(0)).catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
