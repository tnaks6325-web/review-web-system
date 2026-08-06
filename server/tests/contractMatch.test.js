/**
 * 계약 매칭(계약 "연결" → "매칭") 회귀가드.
 *   1. 유사도 판정 순수함수(utils/contractMatch) — 작업명 분해·점수·추천·동점 신호.
 *   2. 업체 스코프 후보 — advertiserForTab(탭지정 > 시트전체) · 인트라넷 응답 **재필터**(where 무시 방어).
 *   3. contractCandidatesForTab — 업체 범위/전체 검색/폴백 사유·추천은 업체 범위에서만.
 *   4. linkSettlement — business_name 우선 · 업체 불일치는 **경고만**(차단 아님) · 쓰기 표면 불변.
 *   5. 라우터 스택 실검사 + 프론트 배선(사본 금지·인덱스 전달).
 * 실행: node tests/contractMatch.test.js
 */
process.env.INTRANET_API_BASE = 'https://intranet.test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cm = require('../src/utils/contractMatch');
const svc = require('../src/services/trackB.service');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const SVC = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');

function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    for (const [re, resp] of routes) if (re.test(String(url))) {
      if (resp === 'throw') throw new Error('intranet down');
      return { ok: true, status: 200, json: async () => resp };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}
function pool(routes) {
  const q = [];
  const api = { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
  api.connect = async () => ({ query: api.query, release() {} });
  return api;
}
// 인트라넷 sales 원본 행(스네이크 케이스) — _mapSales 가 읽는 형태 그대로.
function sale(o) {
  return Object.assign({ id: 'x', contract_number: '', business_name: '', advertiser_name: '', brand_product: '',
    contract_detail: '', product_name: '', contract_month: null, amount: 0 }, o);
}

async function run() {
  const savedFetch = global.fetch;

  // ═══ 1. 판정 순수함수 ═══
  const p = cm.parseTabName('7/21파미고_올레샷_블로그 바이럴');
  assert.equal(p.month, 7, '1a: 앞머리 날짜 월');
  assert.equal(p.day, 21, '1a2: 앞머리 날짜 일');
  assert.equal(p.rest, '파미고_올레샷_블로그 바이럴', '1b: 날짜를 걷어낸 나머지');
  assert.deepEqual(p.tokens, ['파미고', '올레샷', '블로그', '바이럴'], '1c: 토큰 분해');
  assert.equal(cm.parseTabName('26.7.28(화) 파미고_올레샷').month, 7, '1d: 2자리 연도 표기');
  assert.equal(cm.parseTabName('파미고_올레샷').month, null, '1e: 날짜 없으면 null(추측 금지)');
  assert.ok(!cm.parseTabName('7/21 파미고 100건').tokens.includes('100'), '1f: 순수 숫자 토큰 제외');

  assert.equal(cm.normalizeKey('주식회사 파미고'), '파미고', '1g: 법인격 제거');
  assert.equal(cm.normalizeKey('(주)파미고'), '파미고', '1g2: (주) 제거');
  assert.equal(cm.similarity('올레샷', '올레샷 유산균'), 0.95, '1h: 포함관계는 바이그램보다 우선');
  assert.equal(cm.similarity('샷', '올레샷'), 0, '1i: 1글자 포함은 인정 안 함(오탐 차단)');
  assert.equal(cm.similarity('', '파미고'), 0, '1i2: 빈 값은 0');

  const S = [
    { salesId: 'a', contractNumber: 'C-1', businessName: '파미고', brandProduct: '올레샷', contractDetail: '블로그 바이럴 30건', contractMonth: '2026-07', amount: 3000000 },
    { salesId: 'b', contractNumber: 'C-2', businessName: '파미고', brandProduct: '올레샷', contractDetail: '인스타 리뷰', contractMonth: '2026-06', amount: 1000000 },
    { salesId: 'c', contractNumber: 'C-3', businessName: '파미고', brandProduct: '닥터케어', contractDetail: '블로그 바이럴', contractMonth: '2026-07', amount: 500000 },
  ];
  const ranked = cm.rankContracts('7/21파미고_올레샷_블로그 바이럴', S);
  assert.equal(ranked.items[0].salesId, 'a', '1j: 가장 닮은 계약이 1위');
  assert.equal(ranked.recommendedSalesId, 'a', '1k: 추천 = 1위');
  assert.equal(ranked.tie, false, '1l: 동점 아님');
  assert.ok(ranked.items[0].matchScore > ranked.items[1].matchScore, '1m: 점수 내림차순');
  assert.ok(ranked.items[0].matchReasons.some(x => /브랜드/.test(x)), '1n: 근거 문장 동봉');

  // 근거 없는 계약은 추천하지 않는다(빈 추천 > 틀린 추천)
  const weak = cm.rankContracts('7/21파미고_올레샷_블로그 바이럴',
    [{ salesId: 'z', contractNumber: 'C-9', businessName: '전혀다른곳', brandProduct: '엉뚱상품', contractDetail: '배너광고', contractMonth: '2026-01' }]);
  assert.equal(weak.recommendedSalesId, null, '1o: 임계 미만이면 추천 없음');
  assert.equal(cm.rankContracts('7/21파미고', []).recommendedSalesId, null, '1p: 후보 0건이면 추천 없음');

  // 동점은 숨기지 않는다
  const tie = cm.rankContracts('7/21파미고_올레샷', [
    { salesId: 't1', contractNumber: 'C-A', businessName: '파미고', brandProduct: '올레샷', contractMonth: '2026-07' },
    { salesId: 't2', contractNumber: 'C-B', businessName: '파미고', brandProduct: '올레샷', contractMonth: '2026-07' },
  ]);
  assert.equal(tie.tie, true, '1q: 최고점 동점 신호');
  assert.equal(tie.items[0].contractNumber, 'C-A', '1r: 동점 정렬은 결정적(계약번호)');
  // 정보가 없는 항목은 감점하지 않는다(적용 가능한 항목만으로 정규화)
  const sparse = cm.scoreContract('7/21파미고_올레샷', { salesId: 's', businessName: '파미고' });
  assert.equal(sparse.score, 100, '1s: 있는 정보로만 판단(브랜드 미기재를 감점하지 않음)');
  console.log('  1. 판정 순수함수 — 분해·유사도·순위·추천 임계·동점 ✓');

  // ═══ 2. advertiserForTab — 탭지정 > 시트전체 ═══
  let db = pool([
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: [
      { advertiserId: 'adv_all', advertiserName: '시트전체업체', tabGid: null },
      { advertiserId: 'adv_tab', advertiserName: '파미고', tabGid: 777 },
    ] })],
    [/FROM raw_sheet_tabs WHERE/, () => ({ rows: [{ tab_gid: 777 }] })],
  ]); svc.__setPoolForTest(db);
  let owner = await svc.advertiserForTab({ sheetId: 'S1', tabName: 'T' });
  assert.equal(owner.name, '파미고', '2a: 탭지정 소유가 시트전체보다 우선');

  db = pool([
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: [
      { advertiserId: 'adv_all', advertiserName: '시트전체업체', tabGid: null },
      { advertiserId: 'adv_tab', advertiserName: '남의탭', tabGid: 999 },
    ] })],
    [/FROM raw_sheet_tabs WHERE/, () => ({ rows: [{ tab_gid: 777 }] })],
  ]); svc.__setPoolForTest(db);
  owner = await svc.advertiserForTab({ sheetId: 'S1', tabName: 'T' });
  assert.equal(owner.name, '시트전체업체', '2b: gid 안 맞으면 시트전체 소유로');
  db = pool([]); svc.__setPoolForTest(db);
  assert.equal(await svc.advertiserForTab({ sheetId: 'S1', tabName: 'T' }), null, '2c: 소유 없으면 null');
  assert.equal(await svc.advertiserForTab({}), null, '2c2: 인자 없으면 null');
  console.log('  2. advertiserForTab — 탭지정 > 시트전체 · 미지정 null ✓');

  // ═══ 3. intranetSalesForAdvertiser — 서버 응답 재필터(where 무시 방어) ═══
  //   인트라넷 where 파서는 절을 무시하고 **전 계약**을 돌려줄 수 있다 → 이름으로 다시 걸러야 한다.
  let calls = stubFetch([[/\/api\/tables\/sales\?/, { data: [
    sale({ id: 's1', contract_number: 'C-1', business_name: '재필터업체', brand_product: '올레샷' }),
    sale({ id: 's2', contract_number: 'C-2', business_name: '남의업체', brand_product: '기타' }),   // where 무시로 섞여 온 남의 계약
  ] }]]);
  let r = await svc.intranetSalesForAdvertiser('재필터업체');
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1, '3a: 이름이 다른 계약은 후보에서 제외(서버 필터를 믿지 않는다)');
  assert.equal(r.items[0].salesId, 's1', '3a2: 그 업체 계약만 남음');
  assert.equal(r.items[0].brandProduct, '올레샷', '3b: 매칭 재료(brand_product) 매핑');
  assert.ok(calls.every(u => /\/api\/tables\/sales/.test(u)), '3c: 인트라넷은 sales GET만(쓰기 없음)');

  stubFetch([[/\/api\/tables\/sales/, 'throw']]);
  r = await svc.intranetSalesForAdvertiser('도달불가업체');
  assert.equal(r.ok, false, '3d: 인트라넷 도달 불가 = 실패 신호(빈 목록을 정상으로 위장하지 않음)');
  assert.equal(r.error, 'intranet_unreachable', '3d2: 사유 전달');
  assert.deepEqual((await svc.intranetSalesForAdvertiser('')).items, [], '3e: 빈 업체명은 빈 목록');
  console.log('  3. intranetSalesForAdvertiser — 재필터·fail 신호 ✓');

  // ═══ 4. contractCandidatesForTab ═══
  const ownerRows = [{ advertiserId: 'adv_1', advertiserName: '파미고', tabGid: null }];
  db = pool([[/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: ownerRows })]]); svc.__setPoolForTest(db);
  stubFetch([[/\/api\/tables\/sales\?/, { data: [
    sale({ id: 'm1', contract_number: 'C-MATCH', business_name: '파미고', brand_product: '올레샷', contract_detail: '블로그 바이럴', contract_month: '2026-07' }),
    sale({ id: 'm2', contract_number: 'C-OTHER', business_name: '파미고', brand_product: '닥터케어', contract_detail: '배너', contract_month: '2026-02' }),
  ] }]]);
  let out = await svc.contractCandidatesForTab({ sheetId: 'S1', tabName: '7/21파미고_올레샷_블로그 바이럴' });
  assert.equal(out.ok, true);
  assert.equal(out.scope, 'advertiser', '4a: 기본은 업체 범위');
  assert.equal(out.advertiser.name, '파미고', '4a2: 소유 업체 동봉');
  assert.equal(out.items.length, 2, '4b: 그 업체 계약만');
  assert.equal(out.recommendedSalesId, 'm1', '4c: 작업명과 가장 닮은 계약 자동 추천');
  assert.equal(out.items[0].salesId, 'm1', '4c2: 추천이 목록 맨 위');
  assert.ok(out.items.every(i => i.advertiserMatch === true), '4d: 업체 일치 표기');

  // 업체 미지정 → 폴백 사유를 말한다(조용히 전체를 보여주지 않는다)
  db = pool([]); svc.__setPoolForTest(db);
  out = await svc.contractCandidatesForTab({ sheetId: 'S1', tabName: '7/21파미고' });
  assert.equal(out.fallbackReason, 'no_advertiser', '4e: 업체 미지정 사유');
  assert.equal(out.recommendedSalesId, null, '4e2: 근거 없으면 추천 없음');

  // 업체는 있으나 계약 0건
  db = pool([[/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: [{ advertiserId: 'adv_2', advertiserName: '계약없는업체', tabGid: null }] })]]); svc.__setPoolForTest(db);
  stubFetch([[/\/api\/tables\/sales\?/, { data: [] }]]);
  out = await svc.contractCandidatesForTab({ sheetId: 'S1', tabName: '7/22파미고_신규' });
  assert.equal(out.fallbackReason, 'no_contracts', '4f: 계약 0건 사유');

  // 전체 검색(탈출구) — 추천은 내지 않는다
  db = pool([[/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: ownerRows })]]); svc.__setPoolForTest(db);
  stubFetch([[/\/api\/tables\/sales\?/, { data: [
    sale({ id: 'g1', contract_number: 'C-G', business_name: '전혀다른업체', brand_product: '올레샷' }),
  ] }]]);
  out = await svc.contractCandidatesForTab({ sheetId: 'S1', tabName: '7/21파미고_올레샷', scope: 'all', q: '올레샷' });
  assert.equal(out.scope, 'all', '4g: 전체 검색 모드');
  assert.equal(out.recommendedSalesId, null, '4h: 전체 검색에서는 자동 추천 없음(근거 불충분)');
  assert.equal(out.items[0].advertiserMatch, false, '4i: 다른 업체 계약은 경고 재료로 표기');
  assert.equal((await svc.contractCandidatesForTab({ tabName: 'T' })).ok, false, '4j: 인자 누락 거부');
  console.log('  4. contractCandidatesForTab — 업체범위·폴백사유·전체검색·불일치 표기 ✓');

  // ═══ 5. linkSettlement — business_name 우선 · 불일치 경고만 · 쓰기 표면 불변 ═══
  db = pool([
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: ownerRows })],
    [/UPDATE trackb_settlement_links SET deleted_at/, () => ({ rowCount: 0 })],
    [/INSERT INTO trackb_settlement_links/, () => ({ rows: [] })],
  ]); svc.__setPoolForTest(db);
  calls = stubFetch([[/\/api\/tables\/sales\/SX/, { data: { contract_number: 'C-77', business_name: '파미고', advertiser_name: '' } }]]);
  r = await svc.linkSettlement({ sheetId: 'S1', tabName: 'T', salesId: 'SX', by: 'kim' });
  assert.equal(r.ok, true);
  assert.equal(r.advertiserName, '파미고', '5a: business_name 우선(레거시 advertiser_name 공란 대응)');
  assert.equal(r.mismatch, false, '5b: 같은 업체면 불일치 아님');
  assert.ok(db.q.some(x => /INSERT INTO trackb_settlement_links/.test(x.s)), '5c: 링크 테이블만 write');
  assert.ok(!db.q.some(x => /UPDATE advertiser_campaigns|INSERT INTO advertisers|work_orders|order_submissions|review_index/.test(x.s)),
    '5c2: 다른 원장 무접촉');
  assert.ok(calls.every(u => /\/api\/tables\/sales\//.test(u)), '5c3: 인트라넷은 GET만');

  db = pool([
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: ownerRows })],
    [/UPDATE trackb_settlement_links SET deleted_at/, () => ({ rowCount: 0 })],
    [/INSERT INTO trackb_settlement_links/, () => ({ rows: [] })],
  ]); svc.__setPoolForTest(db);
  stubFetch([[/\/api\/tables\/sales\/SY/, { data: { contract_number: 'C-88', business_name: '남의업체' } }]]);
  r = await svc.linkSettlement({ sheetId: 'S1', tabName: 'T', salesId: 'SY', by: 'kim' });
  assert.equal(r.ok, true, '5d: 업체 불일치여도 매칭 자체는 성공(차단 금지 — 다른 이름 등록 정상 케이스)');
  assert.equal(r.mismatch, true, '5d2: 불일치 신호');
  console.log('  5. linkSettlement — business_name 우선·불일치 경고만·쓰기 표면 불변 ✓');

  svc.__setPoolForTest(null); global.fetch = savedFetch;

  // ═══ 6. 라우터 스택 실검사 ═══
  const router = require('../src/routes/trackB.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/settlement/contract-candidates');
  assert.ok(layer, '6a: 후보 라우트 등록');
  assert.ok(layer.route.methods.get, '6a2: GET');
  const names = layer.route.stack.map(s => s.handle.name);
  assert.ok(names.includes('authMiddleware'), '6b: authMiddleware 필수');
  // 스코프 게이트는 핸들러 안 `_ensureEditScope` — 링크와 같은 게이트인지 소스로 확인
  const block = ROUTES.split("router.get('/settlement/contract-candidates'")[1].split('router.')[0];
  assert.ok(/_ensureEditScope\(req, sheetId, tabName\)/.test(block), '6c: 링크와 같은 _ensureEditScope 게이트');
  console.log('  6. 라우터 스택 — 등록·인증·스코프 게이트 ✓');

  // ═══ 7. 사본 금지 / 프론트 배선 ═══
  assert.ok(/require\('\.\.\/utils\/contractMatch'\)/.test(SVC), '7a: 판정은 utils 단일 출처를 쓴다');
  assert.ok(!/rankContracts\s*=|function\s+scoreContract/.test(HTML), '7b: 프론트에 판정 사본 없음(서버 순서·점수를 그대로 그린다)');
  assert.ok(/contract-candidates/.test(HTML), '7c: 프론트가 후보 API 호출');
  assert.ok(/onclick="pickSales\(\$\{i\}\)"/.test(HTML), '7d: 후보 클릭은 배열 인덱스로 전달(값 문자열 주입 금지)');
  assert.ok(/_LK\.items\[Number\(idx\)\]/.test(HTML), '7d2: 인덱스로 되찾기');
  assert.ok(/advertiserMatch===false/.test(HTML), '7e: 다른 업체 계약은 확인(confirm) 후 매칭');
  assert.ok(/계약 매칭/.test(HTML) && !/>계약 연결</.test(HTML), '7f: 어휘가 "계약 매칭"으로 통일');
  assert.ok(/no_advertiser/.test(HTML) && /no_contracts/.test(HTML), '7g: 폴백 사유를 화면이 설명');
  assert.ok(/전체 계약에서 찾기/.test(HTML), '7h: 전체 검색 탈출구 유지');
  assert.ok(/lkrecb[^]{0,200}추천/.test(HTML), '7j: 추천 배지');

  // 시안 C(사용자 확정) — 행 렌더러를 실제 실행해 요청 3가지가 지켜지는지 본다.
  const vm = require('vm');
  const rowSrc = HTML.slice(HTML.indexOf('function _lkRowHtml('), HTML.indexOf('function searchSales('));
  const sb = { esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    _wonFmt: n => (Number(n) || 0).toLocaleString('ko-KR') + '원' };
  vm.createContext(sb); vm.runInContext(rowSrc, sb);
  const row = sb._lkRowHtml({ salesId: 'a', contractNumber: 'C-20260702-010', businessName: '어니스트캄',
    brandProduct: '엘라비에', contractDetail: '4/8(메이커스)엘라비에 마스크팩 마케팅', contractMonth: '2026-04',
    amount: 0, contractAmount: 4180000, matchScore: 45, matchReasons: ['브랜드·상품 일치'], advertiserMatch: true }, 0, 'a');
  assert.ok(row.indexOf('4/8(메이커스)엘라비에 마스크팩 마케팅') > -1, '7l: 계약명(계약상품상세) 표기');
  // ★ 계약명이 헤드라인 · 계약고유번호는 보조 — CSS 로 위계를 고정(되돌리면 종전처럼 번호가 제목이 된다).
  const nameCss = (HTML.match(/\.lkname\{([^}]*)\}/) || [, ''])[1];
  const cnoCss = (HTML.match(/\.lkcno\{([^}]*)\}/) || [, ''])[1];
  const px = css => parseFloat((css.match(/font-size:([\d.]+)px/) || [, '0'])[1]);
  assert.ok(px(nameCss) >= 13 && /font-weight:8/.test(nameCss), '7l2: 계약명이 헤드라인 크기·굵기');
  assert.ok(px(cnoCss) > 0 && px(cnoCss) < px(nameCss), '7l3: 계약고유번호는 계약명보다 작은 보조 표기');
  assert.ok(/4,180,000원/.test(row), '7m: 총비용 = amount 없으면 contract_amount 폴백');
  assert.ok(/lkrail[^]{0,120}>45</.test(row), '7n: 좌측 유사도 레일(시안 C)');
  assert.ok(/✓ 브랜드·상품 일치/.test(row), '7o: 일치근거를 체크 표기로 강조');
  const noWhy = sb._lkRowHtml({ salesId: 'b', contractNumber: 'C-2', matchScore: 10, matchReasons: [] }, 1, 'a');
  assert.ok(/lkwhy none[^]{0,120}일치하는 항목 없음/.test(noWhy), '7p: 근거 없으면 그 사실을 문장으로 말한다');
  assert.ok(/\(계약명 없음\)/.test(noWhy), '7q: 계약명 후보가 모두 비면 그 사실을 표기(빈칸 금지)');
  assert.ok(/_lkRowHtml\(s,i,r\.recommendedSalesId\)/.test(HTML), '7r: 행 빌더는 한 벌(사본 금지)');
  console.log('     시안 C 행 렌더러 실행 검증 ✓');
  // 로딩 자리표시자를 깐 함수는 어떤 경로로도 화면을 종결시킨다(무한 로딩 금지 — 레포 규율)
  assert.ok(/다시 시도/.test(HTML.split('async function _lkLoad')[1].split('function _lkRender')[0]), '7k: 실패 시 [다시 시도]로 종결');
  console.log('  7. 사본 금지 · 프론트 배선 ✓');

  // ═══ 8. 작업오더 ← 계약건(088) · 접수 시 자동 매칭 ═══
  const ORDER = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');
  const MIG = fs.readFileSync(path.join(__dirname, '../migrations/088_work_order_contract.sql'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const WOD = fs.readFileSync(path.join(__dirname, '../../frontend/js/work-order-detail.js'), 'utf8');

  for (const col of ['sales_id', 'contract_number', 'quote_id']) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\s+TEXT`).test(MIG), `8a: 088 ${col} TEXT 컬럼(082 의 42804 계열 회피)`);
  }
  assert.ok(!/REFERENCES/i.test(MIG), '8a2: 인트라넷 키에 FK 를 걸지 않는다(D1 무접촉 규율)');
  assert.ok(/\['work_orders', 'sales_id'\]/.test(BOOT), '8b: REQUIRED_SCHEMA 등록(컬럼 누락 = 오더 접수 전면 42703)');
  for (const f of ['sales_id', 'contract_number', 'quote_id']) {
    assert.ok(new RegExp(`'${f}'`).test(ORDER.split('INTAKE_EDITABLE_FIELDS')[1].split('];')[0]), `8c: intake 수정 가능 필드 ${f}`);
  }

  // ★★ INSERT 컬럼 수 ≡ VALUES 자리 수 ≡ 파라미터 수 — 컬럼을 추가하며 가장 흔하게 깨지는 자리.
  const ins = ORDER.split('INSERT INTO work_orders')[1];
  const colList = ins.slice(ins.indexOf('(') + 1, ins.indexOf('VALUES')).replace(/\)\s*$/, '');
  const nCols = colList.split(',').map(s => s.trim()).filter(Boolean).length;
  const valsSeg = ins.slice(ins.indexOf('VALUES'), ins.indexOf('RETURNING'));
  const nVals = (valsSeg.match(/\$\d+|'submitted'/g) || []).length;
  assert.equal(nCols, nVals, `8d: INSERT 컬럼 ${nCols} ≡ VALUES ${nVals}`);
  const maxPlaceholder = Math.max(...(valsSeg.match(/\$(\d+)/g) || []).map(s => +s.slice(1)));
  const argsSeg = ORDER.slice(ORDER.indexOf('RETURNING *`,', ORDER.indexOf('INSERT INTO work_orders')));
  const nArgs = argsSeg.slice(0, argsSeg.indexOf('\n  );')).split('\n')
    .filter(l => /^\s{6}\S/.test(l) && !/^\s*\/\//.test(l)).length;
  assert.equal(nArgs, maxPlaceholder, `8e: 파라미터 ${nArgs} ≡ 최대 자리표시자 $${maxPlaceholder}`);

  // 접수 자동 연결 — 기존 링크는 덮지 않고, 실패해도 접수는 성공(fail-soft)
  const acc = ORDER.split('8b) 정산 계약 자동 연결')[1].split('res.json({')[0];
  assert.ok(/if \(o\.sales_id\)/.test(acc), '8f: 계약 미첨부 오더는 종전 동작(자동 연결 안 함)');
  assert.ok(/deleted_at IS NULL LIMIT 1/.test(acc) && /kept_existing/.test(acc), '8g: 기존 링크가 있으면 덮지 않는다');
  assert.ok(/catch \(linkErr\)/.test(acc) && /접수는 완료/.test(acc), '8h: fail-soft — 연결 실패해도 접수 성공');
  assert.ok(/INSERT INTO trackb_settlement_links/.test(acc) && !/UPDATE trackb_settlement_links/.test(acc),
    '8i: 쓰기 표면은 링크 INSERT 하나(기존 행 UPDATE 없음)');
  assert.ok(/_woKv\("계약건", o\.contract_number\)/.test(WOD), '8j: 작업오더 상세에 계약건 표기');
  assert.ok(/접수할 때<\/b>|<b>접수할 때 자동으로 매칭<\/b>/.test(HTML), '8k: 미연결 안내가 자동 매칭 규칙을 설명');
  console.log('  8. 작업오더 계약건(088) — 스키마·프리플라이트·INSERT 정합·자동 연결 ✓');

  // ═══ 9. 어휘 통일 + 업체관리 진입점 + 두 화면 동기화 ═══
  //   ★ 창구가 둘(작업보드 정산 카드 · 업체관리 연결탭)이 되었으므로 팝업·동기화는 **한 벌**이어야 한다.
  //     사본을 두면 "업체관리에서 매칭했는데 작업보드는 미매칭"으로 갈린다.
  assert.ok(!/계약 연결 필요|>미연결</.test(HTML), '9a: 작업 정산 요약 어휘가 "계약 매칭"으로 통일(계약 연결 잔존 0)');
  assert.ok(/계약 매칭 필요/.test(HTML), '9a2: 미매칭 안내 문구');
  assert.ok(!/정산 링크된 탭만/.test(HTML) && /계약이 매칭된 탭만 표시/.test(HTML), '9a3: 업체관리 안내도 매칭 어휘');

  // 팝업 단일 출처 — 정의 1개, 두 화면이 같은 함수를 부른다.
  assert.equal((HTML.match(/function openContractMatchModal\(/g) || []).length, 1, '9b: 계약 매칭 팝업 정의는 하나(사본 금지)');
  assert.ok(/function openLinkModal\(\)\{[\s\S]{0,300}openContractMatchModal\(/.test(HTML), '9b2: 작업보드 정산 카드도 공용 팝업을 연다');
  assert.ok(/function ownMatchContract\([\s\S]{0,300}openContractMatchModal\(/.test(HTML), '9b3: 업체관리도 같은 팝업을 연다');
  // 팝업 안쪽은 문맥(_lkTab)만 본다 — STATE.settle 직접 참조가 남아 있으면 업체관리에서 열었을 때 죽는다.
  const lkSeg = HTML.slice(HTML.indexOf('async function _lkLoad'), HTML.indexOf('function _contractMatchApplied'));
  assert.ok(!/STATE\.settle/.test(lkSeg), '9c: 후보 조회·선택·해제는 STATE.settle(작업보드 전용 상태)에 의존하지 않는다');
  assert.ok(/const t=_lkTab\(\)/.test(lkSeg), '9c2: 대상 탭은 팝업 문맥에서 가져온다');

  // 업체관리 연결탭 계약 칸 — 헤더·행·onclick 계약
  assert.ok(/h\.push\('<span>계약<\/span>'\)/.test(HTML), '9d: 연결탭 표 헤더 빌더에 [계약] 칸');
  assert.ok(/onclick="ownMatchContract\(event,\$\{i\}\)"/.test(HTML), '9d2: 계약 칸 클릭은 인덱스만 전달(시트에서 온 문자열 주입 금지)');
  assert.ok(/function ownMatchContract\(ev,i\)\{ ?ev\.stopPropagation\(\)/.test(HTML), '9d3: 행 클릭(작업보드 열기)과 격리');

  // ★★ 그리드 열 수 ≡ 헤더 칸 수 — 열을 끼워 넣을 때 가장 흔하게 깨지는 자리라 **세어서** 고정한다.
  //   업체관리 리디자인으로 열 구성이 **열 묶음 토글에 따라 동적**이 됐으므로(정적 CSS 값이 아님)
  //   두 빌더(_ovmGrid·_ovmHead)를 실제로 실행해 8가지 조합 전부에서 칸 수가 같은지 본다(검사 의미 동일·더 강함).
  {
    const grab = (name) => {
      const i = HTML.indexOf(`function ${name}(`);
      assert.ok(i > 0, `9e0: ${name} 존재`);
      let d = 0, j = HTML.indexOf('{', i);
      for (let k = j; k < HTML.length; k++) {
        if (HTML[k] === '{') d++; else if (HTML[k] === '}') { d--; if (!d) return HTML.slice(i, k + 1); }
      }
      throw new Error(`${name} 블록 추출 실패`);
    };
    const src = grab('_ovmGrid') + '\n' + grab('_ovmHead');
    for (const info of [true, false]) for (const prog of [true, false]) for (const setl of [true, false]) {
      const sb = { _ovmCols: () => ({ info, prog, setl }) };
      vm.createContext(sb);
      vm.runInContext(src + ';[_ovmGrid(),_ovmHead()]', sb);
      const [g, head] = vm.runInContext('[_ovmGrid(),_ovmHead()]', sb);
      const gridCols = g.cols.replace(/minmax\([^)]*\)/g, 'X').trim().split(/\s+/).filter(Boolean).length;
      const headCells = (head.match(/<span>/g) || []).length;
      assert.equal(gridCols, headCells, `9e: 그리드 열 ${gridCols} ≡ 헤더 칸 ${headCells} (info=${info} prog=${prog} setl=${setl})`);
      assert.equal(g.n, gridCols, '9e2: _ovmGrid 가 보고한 열 수 = 실제 열 수');
      assert.ok(g.min > 0, '9e3: min-width 는 열 폭 합에서 파생(고정값 되돌림 금지)');
    }
  }

  // 동기화 — 단일 지점 + link/unlink 양쪽에서 호출 + 두 화면 갱신
  assert.equal((HTML.match(/function _contractMatchApplied\(/g) || []).length, 1, '9f: 동기화 지점은 하나');
  // ★ 동기화는 문자열 존재가 아니라 **실행**으로 확인한다(`if(false) delete …` 같은 무력화를 grep 은 통과시킨다).
  const applied = HTML.slice(HTML.indexOf('function _contractMatchApplied('), HTML.indexOf('async function toggleSettleVis'));
  function runApplied(open) {
    const calls = [];
    const box = {
      STATE: {
        ownTabs: [{ sheetId: 'S1', tabName: 'T', salesId: 'OLD', contractNumber: 'C-OLD' }, { sheetId: 'S1', tabName: 'U', salesId: 'KEEP' }],
        ownSettle: { 'S1\tT': { totalCost: 111 }, 'S1\tU': { totalCost: 222 } },
        ownSettleFor: 'ADV', settle: { tab: { sheetId: 'S1', tabName: open } },
      },
      _rerenderOwnTabs: () => calls.push('rerender'),
      loadOwnSettlement: id => calls.push('ownSettlement:' + id),
      loadSettlement: t => calls.push('settlement:' + t.tabName),
    };
    vm.createContext(box); vm.runInContext(applied, box);
    box._contractMatchApplied('S1', 'T', 'NEW', 'C-NEW');
    return { calls, S: box.STATE };
  }
  let a1 = runApplied('T');
  assert.equal(a1.S.ownTabs[0].salesId, 'NEW', '9f2: 업체관리 연결탭 행이 새 계약으로 갱신');
  assert.equal(a1.S.ownTabs[0].contractNumber, 'C-NEW', '9f2b: 계약번호 갱신');
  assert.equal(a1.S.ownTabs[1].salesId, 'KEEP', '9f2c: 다른 탭은 건드리지 않는다');
  assert.ok(a1.calls.includes('rerender'), '9f2d: 연결탭 섹션 재렌더');
  assert.equal(a1.S.ownSettle['S1\tT'], undefined, '9f4: 옛 계약의 금액 요약을 남기지 않는다(다른 계약 숫자 잔존 차단)');
  assert.ok(a1.S.ownSettle['S1\tU'], '9f4b: 다른 탭 요약은 보존');
  assert.ok(a1.calls.includes('ownSettlement:ADV'), '9f3: 정산 요약(견적·계산서·입금) 재조회');
  assert.ok(a1.calls.includes('settlement:T'), '9f5: 그 탭을 열어 둔 작업보드 정산 카드도 재조회');
  const a2 = runApplied('OTHER');
  assert.ok(!a2.calls.some(c => c.startsWith('settlement:')), '9f6: 다른 탭을 보고 있으면 작업보드 카드는 건드리지 않는다');
  const pick = HTML.slice(HTML.indexOf('async function pickSales('), HTML.indexOf('// ★★ 매칭/해제 후 동기화'));
  assert.ok((pick.match(/_contractMatchApplied\(/g) || []).length === 2, '9g: 매칭·해제 둘 다 같은 동기화 지점을 부른다');
  assert.ok(!/loadSettlement\(t\);\s*\}\s*else toast\(\(r&&r\.error\)\|\|'매칭 실패'\)/.test(pick), '9g2: 매칭 후 작업보드만 갱신하던 옛 경로 부활 금지');

  // 계약 칸 렌더러 실제 실행 — 매칭/미매칭 두 상태
  const cellSrc = HTML.slice(HTML.indexOf('function _ownContractCell('), HTML.indexOf('// 업체관리에서 계약 매칭'));
  const cb = { esc: sb.esc }; vm.createContext(cb); vm.runInContext(cellSrc, cb);
  const cellOn = cb._ownContractCell({ salesId: 'S1', contractNumber: 'C-20260702-010' }, 3);
  assert.ok(/octrb on/.test(cellOn) && /C-20260702-010/.test(cellOn) && /ownMatchContract\(event,3\)/.test(cellOn), '9h: 매칭됨 = 계약번호(클릭 시 다시 매칭)');
  const cellOff = cb._ownContractCell({ salesId: null, tabName: 't' }, 0);
  assert.ok(/계약 매칭/.test(cellOff) && !/octrb on/.test(cellOff), '9h2: 미매칭 = [계약 매칭] 어포던스');
  // 계약번호는 인트라넷에서 온 값 — 본문·title 속성 양쪽에 escape 되어 들어간다(태그·따옴표 탈출 불가).
  const cellXss = cb._ownContractCell({ salesId: 'x', contractNumber: '"><img src=x>' }, 1);
  assert.ok(!/<img/i.test(cellXss) && /&lt;img/.test(cellXss) && !/title="">/.test(cellXss), '9h3: 계약번호는 escape(태그·속성 탈출 없음)');
  console.log('  9. 어휘 통일 · 업체관리 진입점 · 두 화면 동기화 ✓');

  console.log('✅ contractMatch 테스트 전체 통과');
}

run().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
