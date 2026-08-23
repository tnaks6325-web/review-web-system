/**
 * 업체관리 화면 리디자인(시안 A) 회귀가드.
 *   시안·결정 = frontend/docs/design-vendor-management.html (사용자 확정: A안 / 정산상세 접힘 기본 +
 *   브라우저 기억 / '처리필요' = 마감자료 검수 대기만 / 개요 집계 추가)
 *
 *   1. finishCandidate — 마감자료 검수 대기 판정 **순수함수 단일 출처**(실행 검증).
 *   2. advertiserOverview — 업체별 집계(로컬 DB만·인트라넷 무접촉) · 마감 gid 폴백 · 실패 플래그.
 *   3. ownedTabsForAdvertiser — {rows, *Unavailable} 계약 + finishCand/finished 주석.
 *   4. 라우터 스택 실검사 + 핸들러 실행(?overview=1 병합 · 플래그 전달).
 *   5. 프론트 배선 — 기존 계약 생존 · IME(입력칸 미재렌더) · ESC document 1회 · onclick 인덱스만.
 *   6. 동적 열 구성 — 헤더 칸 ≡ grid 열(8조합 실행) · min-width 파생 · 기본은 정산상세 접힘.
 *   7. 무신호 금지 — 집계·통계 실패를 '?'·경고로 고지(0 으로 위장하지 않는다).
 * 실행: node tests/vendorManagementRedesign.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/trackB.service');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const SVC = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ` — ${extra}` : '')); console.log('  ✓ ' + name); pass++; };

/** 스텁 pool — SQL 패턴별 응답. connect() 도 같은 query 를 쓴다. */
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
/** workdesk.html 에서 함수 블록을 중괄호 균형으로 뽑아온다(vm 실행용). */
function grab(name, src = HTML) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i > 0, `블록 추출: function ${name} 존재`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 블록 추출 실패`);
}

async function run() {
  /* ═══ 1. finishCandidate — 판정 단일 출처 ═══ */
  console.log('\n1) 마감자료 검수 대기 판정(finishCandidate)');
  const fc = svc.finishCandidate;
  t('전건 제출 + 전건 입금 = 후보', fc({ total: 100, submitted: 100, paid: 100 }) === true);
  t('제출 미달 = 아님', fc({ total: 100, submitted: 99, paid: 100 }) === false);
  t('입금 미달 = 아님', fc({ total: 100, submitted: 100, paid: 99 }) === false);
  t('초과 달성도 후보(>= 판정)', fc({ total: 10, submitted: 12, paid: 11 }) === true);
  // ★ 통계가 없으면 판정하지 않는다 — 모르면 제안하지 않는다(0/undefined/null 을 "충족"으로 접지 않는다)
  t('★ 통계 없음 = 판정 안 함', fc(null) === false && fc(undefined) === false && fc({}) === false);
  t('★ total 0 = 판정 안 함(0>=0 을 충족으로 읽지 않는다)', fc({ total: 0, submitted: 0, paid: 0 }) === false);
  t('★ total 이 숫자가 아니면 판정 안 함', fc({ total: null, submitted: 5, paid: 5 }) === false
    && fc({ total: 'x', submitted: 5, paid: 5 }) === false);
  t('submitted/paid 누락은 0 취급(충족 아님)', fc({ total: 5 }) === false);

  /* ═══ 2. advertiserOverview — 집계·gid 폴백·무접촉 ═══ */
  console.log('\n2) 업체별 개요 집계(advertiserOverview)');
  const savedFetch = global.fetch;
  let fetched = 0; global.fetch = async () => { fetched++; return { ok: false, status: 500, json: async () => ({}) }; };
  const ownRows = [
    { advertiserId: 'A', sheetId: 'S1', tabGid: 11, tabName: 'T1' },   // 계약O · 후보O
    { advertiserId: 'A', sheetId: 'S1', tabGid: 12, tabName: 'T2' },   // 계약X · 후보X
    { advertiserId: 'A', sheetId: 'S1', tabGid: 13, tabName: 'T3' },   // 계약X · 후보지만 **마감됨**(gid 로 매칭)
    { advertiserId: 'B', sheetId: 'S2', tabGid: 21, tabName: 'U1' },   // 계약X · 통계없음
  ];
  let db = pool([
    [/FROM tabs t JOIN own o/, () => ({ rows: ownRows })],
    [/FROM trackb_settlement_links WHERE deleted_at IS NULL/, () => ({ rows: [{ sheetId: 'S1', tabName: 'T1' }] })],
    [/FROM trackb_advertiser_links/, () => ({ rows: [{ advertiserId: 'A', active: true, loginRequired: false, lastUsedAt: null, hasToken: true }] })],
    // tabStatsMap / finishedTabsMap 이 쓰는 쿼리
    [/FROM tab_configs tc/, () => ({ rows: [
      { sheetId: 'S1', tabName: 'T1', rowCount: 10, submittedCount: 10, paidCount: 10 },
      { sheetId: 'S1', tabName: 'T2', rowCount: 10, submittedCount: 3, paidCount: 0 },
      { sheetId: 'S1', tabName: 'T3', rowCount: 10, submittedCount: 10, paidCount: 10 },
    ] })],
    [/FROM trackb_tab_finished WHERE deleted_at IS NULL/, () => ({ rows: [{ sheetId: 'S1', tabName: '옛이름', tabGid: 13, finishedAt: 'x', finishedBy: 'me' }] })],
  ]);
  svc.__setPoolForTest(db);
  svc.__resetTabStatsCacheForTest && svc.__resetTabStatsCacheForTest();
  let ov = await svc.advertiserOverview({ force: true });
  t('집계 성공', ov.ok === true);
  t('작업 수 = 소유 탭 수', ov.byAdvertiser.A.works === 3 && ov.byAdvertiser.B.works === 1);
  t('계약 미매칭 = 정산 링크 없는 탭', ov.byAdvertiser.A.noMatch === 2, JSON.stringify(ov.byAdvertiser.A));
  t('★ 마감된 탭은 마감자료 검수 대기에서 제외(gid 폴백으로 매칭 — 리네임 대비)', ov.byAdvertiser.A.finishCand === 1,
    'finishCand=' + ov.byAdvertiser.A.finishCand);
  t('통계 없는 탭은 판정 안 함', ov.byAdvertiser.B.finishCand === 0);
  t('접속 링크 상태 동봉(없는 업체는 미포함 = 미생성)', ov.link.A && ov.link.A.active === true && !ov.link.B);
  t('★★ 인트라넷 무접촉(개요는 로컬 DB 집계만 — 17업체분 프록시 금지)', fetched === 0, 'fetch=' + fetched);
  t('★ 접속 링크를 여기서 생성하지 않는다(읽기 전용 — INSERT 0)',
    !db.q.some(x => /INSERT INTO trackb_advertiser_links/.test(x.s)));
  t('★ 쓰기 쿼리 0(개요는 순수 조회)', !db.q.some(x => /\b(INSERT|UPDATE|DELETE)\b/i.test(x.s)));

  // 소스별 실패는 플래그로 — 조용히 0 을 돌려주지 않는다
  db = pool([
    [/FROM tabs t JOIN own o/, () => ({ rows: [{ advertiserId: 'A', sheetId: 'S1', tabGid: 11, tabName: 'T1' }] })],
    [/FROM trackb_settlement_links WHERE deleted_at IS NULL/, () => { throw new Error('42P01'); }],
    [/FROM trackb_advertiser_links/, () => { throw new Error('boom'); }],
    [/FROM tab_configs tc/, () => { throw new Error('boom'); }],
    [/FROM trackb_tab_finished WHERE deleted_at IS NULL/, () => { throw new Error('boom'); }],
  ]);
  svc.__setPoolForTest(db);
  svc.__resetTabStatsCacheForTest && svc.__resetTabStatsCacheForTest();
  ov = await svc.advertiserOverview({ force: true });
  t('★ 계약 링크 조회 실패 = 플래그(미매칭 0 으로 위장하지 않는다)',
    ov.contractsUnavailable === true && ov.byAdvertiser.A.noMatch === 0);
  t('★ 통계·마감 조회 실패 = 플래그', ov.statsUnavailable === true && ov.finishedUnavailable === true);
  t('★ 접속링크 조회 실패 = 플래그', ov.linksUnavailable === true);
  // 소유탭 조회 자체가 죽으면 ok:false (화면이 '?'로 고지)
  db = pool([[/FROM tabs t JOIN own o/, () => { throw new Error('down'); }]]);
  svc.__setPoolForTest(db);
  ov = await svc.advertiserOverview({ force: true });
  t('★ 소유탭 조회 실패 = ok:false(부분 성공으로 위장 금지)', ov.ok === false);

  /* ═══ 3. ownedTabsForAdvertiser 계약 ═══ */
  console.log('\n3) 연결탭 응답 계약');
  db = pool([
    [/FROM tabs t LEFT JOIN LATERAL/, () => ({ rows: [
      { sheetId: 'S1', tabName: 'T1', tabGid: 11, bTotal: 10, bSub: 10, bPaid: 10 },
      { sheetId: 'S1', tabName: 'T2', tabGid: 12, bTotal: 10, bSub: 1, bPaid: 0 },
    ] })],
    [/FROM tab_configs tc/, () => ({ rows: [
      { sheetId: 'S1', tabName: 'T1', rowCount: 10, submittedCount: 10, paidCount: 10 },
      { sheetId: 'S1', tabName: 'T2', rowCount: 10, submittedCount: 1, paidCount: 0 },
    ] })],
    [/FROM trackb_tab_finished WHERE deleted_at IS NULL/, () => ({ rows: [] })],
  ]);
  svc.__setPoolForTest(db);
  svc.__resetTabStatsCacheForTest && svc.__resetTabStatsCacheForTest();
  const own = await svc.ownedTabsForAdvertiser({ advertiserId: 'A', annotate: true });
  t('★ {rows, statsUnavailable, finishedUnavailable} 로 반환(실패를 화면이 고지할 수 있게)',
    Array.isArray(own.rows) && 'statsUnavailable' in own && 'finishedUnavailable' in own);
  t('행마다 finishCand/finished 주석', own.rows[0].finishCand === true && own.rows[0].finished === false
    && own.rows[1].finishCand === false);
  t('★ 판정 재료는 홈과 같은 tabStatsMap(연결탭 표의 bTotal/bSub/bPaid 로 따로 세지 않는다)',
    /const st = await tabStatsMap\(\);[\s\S]{0,420}finishCandidate\(st\.map\[k\]\)/.test(SVC));
  // ★★ 주석(통계·마감)은 opt-in — 광고주 경로(advertiserWorkSummary → /my-work-summary, 무로그인 공개
  //   링크로도 도달)와 정산 요약·브랜드 배정에 review_index 전체 GROUP BY 를 얹으면 안 된다(CLAUDE.md).
  {
    const before = db.q.length;
    const plain = await svc.ownedTabsForAdvertiser({ advertiserId: 'A' });   // annotate 미지정
    const asked = db.q.slice(before).map(x => x.s).join(' | ');
    t('★ annotate 없으면 통계·마감을 조회하지 않는다(광고주 경로 비용 0)',
      !/FROM tab_configs tc/.test(asked) && !/trackb_tab_finished/.test(asked), asked.slice(0, 120));
    t('annotate 없으면 판정 주석도 없다(모르는 값을 false 로 단정하지 않게 화면이 안 쓴다)',
      plain.rows[0].finishCand === undefined && plain.statsUnavailable === false);
    t('★ 주석을 켜는 곳은 /ownership/tabs 하나뿐', (ROUTES.match(/annotate: true/g) || []).length === 1);
    // 선언부(`async function ...({ advertiserId, annotate = false })`)는 제외하고 **호출부**만 본다.
    t('★ 광고주·정산·브랜드 경로는 annotate 를 켜지 않는다',
      !/await ownedTabsForAdvertiser\(\{ advertiserId, annotate/.test(SVC)
      && (SVC.match(/ownedTabsForAdvertiser\(\{ advertiserId \}\)\)\.rows/g) || []).length >= 3);
  }

  /* ═══ 4. 라우터 ═══ */
  console.log('\n4) 라우터 · 핸들러 실행');
  const router = require('../src/routes/trackB.routes');
  const layer = (m, p) => (router.stack || []).find(l => l.route && l.route.path === p && l.route.methods[m]);
  const advL = layer('get', '/advertisers');
  t('GET /advertisers 존재', !!advL);
  t('내부인 게이트(authMiddleware + internalMiddleware) 유지', advL.route.stack.length >= 3,
    'handlers=' + advL.route.stack.length);
  // ★ 신규 엔드포인트 0 — 개요는 ?overview=1 로 같은 라우트에 얹는다.
  //   (기존 관측 뷰의 GET /overview 와 혼동 금지 — 그건 이 작업 이전부터 있던 다른 화면이다.)
  t('★ 신규 개요 엔드포인트를 만들지 않았다', !(router.stack || []).some(l => l.route
    && /advertisers?[-/]overview|ownership\/overview/.test(l.route.path)));
  t('개요 병합은 /advertisers 핸들러 안에서 한다', /req\.query\.overview === '1'[\s\S]{0,400}svc\.advertiserOverview\(\)/.test(ROUTES));

  // 핸들러 실행 — overview 병합
  const runHandler = async (l, req) => {
    const h = l.route.stack[l.route.stack.length - 1].handle;
    let body = null, code = 200;
    const res = { json: b => { body = b; return res; }, status: c => { code = c; return res; } };
    await h(req, res, e => { throw e || new Error('next 호출'); });
    return { body, code };
  };
  db = pool([
    [/FROM advertisers a LEFT JOIN trackb_advertiser_prefs/, () => ({ rows: [
      { id: 'A', name: '어니스트캄', inadPm: '황운하', owned: 1, settlementVisible: true },
      { id: 'Z', name: '소유없는업체', inadPm: '', owned: 0, settlementVisible: true },
    ] })],
    [/FROM tabs t JOIN own o/, () => ({ rows: [{ advertiserId: 'A', sheetId: 'S1', tabGid: 11, tabName: 'T1' }] })],
    [/FROM trackb_settlement_links WHERE deleted_at IS NULL/, () => ({ rows: [] })],
    [/FROM trackb_advertiser_links/, () => ({ rows: [{ advertiserId: 'A', active: true, loginRequired: true, lastUsedAt: null, hasToken: true }] })],
    [/FROM tab_configs tc/, () => ({ rows: [{ sheetId: 'S1', tabName: 'T1', rowCount: 5, submittedCount: 5, paidCount: 5 }] })],
    [/FROM trackb_tab_finished WHERE deleted_at IS NULL/, () => ({ rows: [] })],
  ]);
  svc.__setPoolForTest(db);
  svc.__resetTabStatsCacheForTest && svc.__resetTabStatsCacheForTest();
  let out = await runHandler(advL, { query: { overview: '1' }, admin: { role: 'admin', name: 'k' } });
  t('?overview=1 이면 items 에 집계가 병합된다',
    out.body.items[0].works === 1 && out.body.items[0].noMatch === 1 && out.body.items[0].finishCand === 1);
  t('소유 탭 0건 업체도 0 으로 채워진다(undefined 로 남기지 않는다)',
    out.body.items[1].works === 0 && out.body.items[1].noMatch === 0);
  t('접속링크 상태 병합 · 없는 업체는 null', out.body.items[0].link.loginRequired === true && out.body.items[1].link === null);
  t('★ overview 플래그를 응답에 실어 화면이 고지할 수 있게 한다', out.body.overview && out.body.overview.ok === true);
  // ★ 접속링크 상태는 **내부인 전원**(AE 포함, 2026-08-19 사용자 확정) — 링크 CRUD(/advertiser-link)가
  //   이미 internalMiddleware 라 목록만 admin 으로 좁히면 "서버는 허용하는데 화면은 —" 인 비대칭이 된다.
  //   ★ 단 토큰은 어느 역할에도 싣지 않는다(hasToken 만 — 복사는 누를 때 ensure 로 받아온다).
  svc.__resetTabStatsCacheForTest();
  const staffOut = await runHandler(advL, { query: { overview: '1' }, admin: { role: 'staff', name: 'ae' } });
  t('★ staff 응답에도 접속링크 상태가 실린다(라우트 게이트와 1:1)',
    staffOut.body.items[0].link && staffOut.body.items[0].link.active === true && staffOut.body.items[1].link === null,
    JSON.stringify(staffOut.body.items[0]).slice(0, 160));
  t('★ 어느 역할에도 접속 토큰은 내려보내지 않는다(데이터 최소화)',
    !/"token"/.test(JSON.stringify(staffOut.body.items)) && !/"token"/.test(JSON.stringify(out.body.items)));
  t('staff 도 작업수·미매칭·검수 집계는 받는다(담당 판단에 필요)', staffOut.body.items[0].works === 1);
  out = await runHandler(advL, { query: {}, admin: { role: 'admin', name: 'k' } });
  t('★ overview 미지정이면 종전 응답 그대로(기존 소비처 무영향)',
    out.body.items[0].works === undefined && out.body.overview === undefined);

  const otL = layer('get', '/ownership/tabs');
  db = pool([
    [/FROM tabs t LEFT JOIN LATERAL/, () => ({ rows: [{ sheetId: 'S1', tabName: 'T1', tabGid: 11 }] })],
    [/FROM tab_configs tc/, () => { throw new Error('boom'); }],
    [/FROM trackb_tab_finished WHERE deleted_at IS NULL/, () => ({ rows: [] })],
  ]);
  svc.__setPoolForTest(db);
  svc.__resetTabStatsCacheForTest && svc.__resetTabStatsCacheForTest();
  out = await runHandler(otL, { query: { advertiserId: 'A' }, admin: { role: 'admin', name: 'k' } });
  t('★ /ownership/tabs 가 statsUnavailable 를 응답에 싣는다(088 무신호 규율)',
    out.body.statsUnavailable === true && Array.isArray(out.body.items));

  global.fetch = savedFetch;

  /* ═══ 5. 프론트 배선 — 기존 계약 생존 ═══ */
  console.log('\n5) 프론트 배선 · 기존 계약 생존');
  t('★ renderOwnershipView 첫 동작 = pendingAdv 없으면 advCur 비움(히스토리 항목 ↔ 화면 일치)',
    /async function renderOwnershipView\(\)\{[\s\S]{0,500}if\(!STATE\.pendingAdv\) STATE\.advCur=null;/.test(HTML));
  t('뒤로가기 복원 경로 유지(pendingAdv → selAdv)', /STATE\.pendingAdv[\s\S]{0,300}selAdv\(ix,\{nav:!!pa\.__nav\}\)/.test(HTML));
  // ★★ 사용자 확정(2026-08-23): 지정 단위가 **작업(작업보드)** 로 바뀌며 시트 선택 칸(#addSheet·#advSheet·
  //    #taboptions)은 작업 선택 칸(#addTabSel·#advTabSel)으로 교체됐다 — 나머지 계약은 그대로.
  for (const id of ['ownPanel', 'owntabsSect', 'advs', 'addTabSel', 'advTabSel', 'advName',
    'advSug', 'advNameChk', 'advPm', 'advPmChk', 'advCreateBtn', 'setvis', 'aebox']) {
    t(`기존 id 생존: #${id}`, new RegExp(`id="${id}"`).test(HTML));
  }
  t('기존 클래스 계약 생존(.advitem[data-i]·.ct·.pmn)',
    /class="advitem\$\{[^}]*\}" data-i="\$\{i\}"/.test(HTML) && /class="ct"/.test(HTML) && /class="pmn /.test(HTML));
  // onclick 에는 인덱스만 — 시트/업체에서 온 문자열을 넣지 않는다(M1 실측 XSS)
  for (const [fn, pat] of [['openOwnTab', /onclick="openOwnTab\(\$\{i\}\)"/], ['editTabMemo', /onclick="editTabMemo\(event,\$\{i\}\)"/],
    ['ownMatchContract', /onclick="ownMatchContract\(event,\$\{i\}\)"/], ['selAdv', /onclick="selAdv\(\$\{i\}\)"/],
    ['deleteAdv', /onclick="event\.stopPropagation\(\);deleteAdv\(\$\{i\}\)"/]]) {
    t(`★ onclick 은 인덱스만 전달: ${fn}`, pat.test(HTML));
  }
  // ★★ IME — 검색 중 입력칸을 재렌더하지 않는다
  const rr = grab('_rerenderOwnTabs');
  t('★★ 정산 요약 도착이 도구줄을 재렌더하지 않는다(입력칸 DOM 유지 = IME 조합 보존)',
    /querySelector\('#ownRows'\)[\s\S]{0,80}_ovmRenderRows\(\);\s*return;/.test(rr), rr.replace(/\s+/g, ' ').slice(0, 160));
  const rrows = grab('_ovmRenderRows');
  t('★ 검색 렌더는 #ownRows 만 교체한다', /\$\('#ownRows'\)/.test(rrows) && !/#owntabsSect/.test(rrows));
  t('★ 검색 입력 핸들러가 섹션을 다시 그리지 않는다',
    /function _ovmSearch\(v\)\{[^}]*_ovmRenderRows\(\);/.test(HTML) && !/function _ovmSearch\(v\)\{[^}]*_rerenderOwnTabs/.test(HTML));
  t('비고 편집 중 재렌더 연기 로직 유지(입력 무음 소실 방지)', /\.omemoin'\)\)\{ STATE\._ownRerenderPending=true; return; \}/.test(rr));
  // ESC — document 에 1회
  const escM = HTML.match(/document\.addEventListener\('keydown',function\(e\)\{ if\(e\.key==='Escape'&&_ovmDrawer\)/g) || [];
  t('★ ESC 리스너는 document 에 정확히 1회(컨테이너에 붙이면 포커스 밖에서 안 닫힌다)', escM.length === 1, 'n=' + escM.length);
  // 설정 패널 = 뷰 스크롤 컨테이너 밖 + fixed
  t('★ 설정 패널·스크림은 .own-wrap 밖(뷰 루트 직속)에 마운트', /<\/div>\s*<div class="ovm-scrim" id="ovmScrim"/.test(HTML));
  t('★ 설정 패널은 position:fixed(스크롤 컨테이너 안에 두면 화면 흐름에 섞인다)',
    /\.ovm-drawer\{position:fixed/.test(HTML) && /\.ovm-scrim\{position:fixed/.test(HTML));
  t('열 선택은 브라우저에 기억(localStorage)', /_OVM_COLS_KEY='wd_own_cols'/.test(HTML) && /localStorage\.setItem\(_OVM_COLS_KEY/.test(HTML));
  // ★ 2026-08 사용자 확정: 접속링크·광고주 계정도 AE 가 관리한다(서버 라우트 internalMiddleware).
  //   그래서 검사는 "admin 만"이 아니라 **화면 판정이 서버 게이트와 같은 함수를 쓰는가**로 바꾼다 —
  //   `_isInternalRole()` 이 사라지고 좁은/넓은 사본이 생기면 버튼과 서버가 다시 갈린다.
  t('접속링크·계정 버튼 게이트 = 서버 게이트와 1:1(_isInternalRole 단일 판정)',
    /const isAdmin=_isInternalRole\(\);[\s\S]{0,2200}\$\{isAdmin\?`<button class="btn ovm-setbtn" onclick="_ovmOpenDrawer\('link'\)/.test(HTML)
    && /function _isInternalRole\(\)\{[^}]*r==='master'[^}]*r==='admin'[^}]*r==='staff'/.test(HTML));
  t('개요·연결탭이 같은 판정을 쓴다(서버 불리언 소비 — 프론트 재계산 금지)',
    /t\.finishCand/.test(HTML) && !/function isOwnFinishCandidate/.test(HTML));

  // ★★ B1 — 소스별 실패 플래그를 화면이 실제로 소비하는가(ok 만 보면 statsUnavailable 이 0 으로 위장된다)
  {
    const sb = { STATE: { ovMeta: null } };
    vm.createContext(sb);
    vm.runInContext(grab('_ovmCandKnown') + grab('_ovmCandWhy') + grab('_ovmMatchKnown') + grab('_ovmLinkKnown'), sb);
    const set = m => { sb.STATE.ovMeta = m; };
    const known = () => vm.runInContext('[_ovmCandKnown(),_ovmMatchKnown(),_ovmLinkKnown()]', sb);
    set({ ok: true }); assert.deepEqual(known(), [true, true, true], '플래그 없으면 전부 known');
    set({ ok: true, statsUnavailable: true });
    t('★ statsUnavailable = 마감자료 검수 판정 불가(ok 만 보면 0 으로 위장된다)', known()[0] === false && known()[1] === true);
    set({ ok: true, finishedUnavailable: true });
    t('★ finishedUnavailable = 판정 불가', known()[0] === false);
    set({ ok: true, contractsUnavailable: true });
    t('★ contractsUnavailable = 계약 미매칭 "모름"(다 매칭됨으로 위장 금지)', known()[1] === false);
    set({ ok: true, linksUnavailable: true });
    t('★ linksUnavailable = 접속링크 "모름"(미생성으로 위장 금지 — 폐기·로그인필요를 틀리게 안내한다)', known()[2] === false);
    set({ ok: false }); assert.deepEqual(known(), [false, false, false], 'ok:false 면 전부 모름');
    set(null); assert.deepEqual(known(), [false, false, false], '집계 미도착도 모름');
    set({ ok: true, statsUnavailable: true });
    t('모름 사유를 문장으로 말한다', /통계/.test(vm.runInContext('_ovmCandWhy()', sb)));
  }
  t('★ 개요 접속링크 열은 모름(?)과 미생성을 구분한다', /!linkKnown \?[\s\S]{0,160}: !lk \?/.test(HTML));
  t('★ 사이드바 검수 칩은 판정 불가면 클릭도 막는다(확정 문장 오독 차단)',
    /ovOk\?'':' disabled title="'\+_ovmCandWhy\(\)\+'"'/.test(HTML));
  // ★★ B2 — 미분류('') 브랜드 필터가 살아 있는가(실행으로 확인)
  {
    const sb = { STATE: { ownBrand: null, ownBrandList: ['브랜드A', '브랜드B'] }, _ovmRenderRows() {}, $: () => null };
    vm.createContext(sb);
    vm.runInContext(grab('setOwnBrandByName') + grab('setOwnBrand'), sb);
    const pick = i => { vm.runInContext(`setOwnBrand(${i})`, sb); return sb.STATE.ownBrand; };
    t('브랜드 전체(-1) → null', pick(-1) === null);
    t('브랜드 선택(0) → 그 브랜드', pick(0) === '브랜드A');
    t('★★ 미분류(-2) → 빈 문자열(null 로 접으면 브랜드 없는 탭만 보기가 죽는다)', pick(-2) === '');
  }
  // ★ M1 — 전체 렌더에서도 검색어·건수가 살아 있는가
  t('★ 검색 입력칸에 현재 검색어를 싣는다(전체 렌더 후에도 유지)', /id="ovmQ" value="\$\{esc\(_ovmQ\)\}"/.test(HTML));
  t('★ 비고 저장 후 재렌더도 행 경로로 수렴(검색어·건수 초기화 방지)',
    /const rerender=\(\)=>\{ STATE\._ownRerenderPending=false;\s*\n\s*if\(\$\('#ownRows'\)\)\{ _ovmRenderRows\(\); return; \}/.test(HTML));
  t('건수·칩 표기는 한 함수(_ovmSyncCnt)로 수렴', (HTML.match(/function _ovmSyncCnt\(/g) || []).length === 1
    && /function _ovmRenderRows\(\)\{[\s\S]{0,160}_ovmSyncCnt\(\);/.test(HTML));
  // ★ M4 — 로딩 자리표시자를 깐 함수는 어떤 예외에도 화면을 종결시킨다
  t('★ 목록 조회 실패·예외를 화면이 종결한다(무한 "불러오는 중" 금지)',
    /catch\(err\)\{ _ovmLoadFailed\(err&&err\.message\); return; \}/.test(HTML)
    && /function _ovmLoadFailed\(why\)\{/.test(HTML) && /onclick="renderOwnershipView\(\)"/.test(HTML));
  // ★ 어휘 통일(2026-08-23): '연결된 탭' → '연결된 작업'. 검사 의미 불변(실패를 "없음"으로 위장 금지).
  t('연결 작업 조회 실패는 "없음"이라고 행동을 지시하지 않는다',
    /unreachable\)\s*\n?\s*return `<div class="st">연결된 작업 <span class="sthint">불러오지 못함/.test(HTML));
  t('닫은 설정 패널은 Tab 순서에서 빠진다(화면 밖 폼 갇힘 방지)',
    /d\.classList\.remove\('on'\); d\.setAttribute\('aria-hidden','true'\); d\.innerHTML='';/.test(HTML));
  t('개요 행은 Enter/Space 로도 열린다', /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/.test(HTML));
  t('[← 전체 개요] 복귀도 히스토리에 쌓는다(뒤로가기 헛클릭 방지)', /if\(wasAdv && !\(opt&&opt\.nav\) && typeof _navPush==='function'\) _navPush\(\);/.test(HTML));
  // ★ 사용자 확정(2026-08-23): 배너 재료가 '미지정 시트(/owned-sheets)' → **미지정 작업(mapTabs)** 로 바뀌었다.
  //   [×] 해제 뒤에도 숫자가 옛값으로 남지 않으려면 여기서 mapTabs 를 다시 받아야 한다.
  t('소유 변경 후 미지정 작업 배너도 갱신(사이드바 상시 노출이라 stale 이 눈에 띈다)',
    /async function refreshAdvCounts\(\)\{[\s\S]{0,400}_ovmReloadMapTabs\(\)/.test(HTML));
  t('staff 설정 패널은 소유 작업만(막다른 길 제거)', /const keys=isAdmin\?\['link','acct','own'\]:\['own'\];/.test(HTML));

  /* ═══ 6. 동적 열 구성 ═══ */
  console.log('\n6) 동적 열 구성(헤더 ≡ grid)');
  const src = grab('_ovmGrid') + '\n' + grab('_ovmHead');
  let baseN = null;
  let combos = 0;
  for (const info of [true, false]) for (const prog of [true, false]) for (const mat of [true, false]) for (const setl of [true, false]) {
    const sb = { _ovmCols: () => ({ info, prog, mat, setl }) };
    vm.createContext(sb); vm.runInContext(src, sb);
    const [g, head] = vm.runInContext('[_ovmGrid(),_ovmHead()]', sb);
    const cols = g.cols.replace(/minmax\([^)]*\)/g, 'X').trim().split(/\s+/).filter(Boolean).length;
    const cells = (head.match(/<span>/g) || []).length;
    assert.equal(cols, cells, `헤더 칸 ${cells} ≡ grid 열 ${cols} (info=${info} prog=${prog} mat=${mat} setl=${setl})`);
    assert.equal(g.n, cols, 'g.n = 실제 열 수');
    assert.ok(/min-width:\d+px/.test(head), 'min-width 를 헤더에도 싣는다');
    assert.ok(g.min > 0 && g.min < 3000, 'min-width 는 열 폭 합에서 파생');
    combos++;
    if (info && prog && mat && setl === false) baseN = cols;
  }
  t('16가지 열 묶음 조합 전부에서 헤더 칸 ≡ grid 열', combos === 16, 'combos=' + combos);
  // 기본 = 작업정보·진척·자료 켬 + 정산상세 접힘(사용자 확정) → 13칸. FHD 폭 상한(1560) 안에서
  //   가로 스크롤이 없어야 한다는 약속의 전제이므로 숫자를 고정한다.
  t('★ 기본(자료 켬·정산상세 접힘)은 13칸', baseN === 13, 'cols=' + baseN);
  {
    const sb = { _ovmCols: () => ({ info: true, prog: true, mat: true, setl: false }) };
    vm.createContext(sb); vm.runInContext(src, sb);
    const off = vm.runInContext('_ovmGrid().min', sb);
    sb._ovmCols = () => ({ info: true, prog: true, mat: true, setl: true });
    const on = vm.runInContext('_ovmGrid().min', sb);
    t('★ 정산상세를 펼치면 min-width 가 커진다(접었을 때 폭도 함께 줄어든다)', on > off, `${off} → ${on}`);
  }
  // 행 필터 판정 — 칩 숫자와 목록이 같은 함수를 쓴다
  {
    const sb = { STATE: { ownSettle: { 'S\tT1': { totalCost: 100, paidAmount: 40 }, 'S\tT2': { totalCost: 100, paidAmount: 100 } } },
      parseTabMeta: () => ({}) };
    vm.createContext(sb); vm.runInContext(grab('_ownBrand'), sb); vm.runInContext(grab('_ovmRowMatch'), sb);
    const m = (t2, f) => vm.runInContext('_ovmRowMatch', sb)(t2, f, '');
    t('미매칭 필터', m({ sheetId: 'S', tabName: 'T1', salesId: null }, 'nomatch') === true
      && m({ sheetId: 'S', tabName: 'T1', salesId: 'X' }, 'nomatch') === false);
    t('마감자료 검수 필터 = 서버 불리언', m({ sheetId: 'S', tabName: 'T1', finishCand: true }, 'cand') === true
      && m({ sheetId: 'S', tabName: 'T1' }, 'cand') === false);
    t('미입금 필터(총비용 > 입금액)', m({ sheetId: 'S', tabName: 'T1' }, 'unpaid') === true
      && m({ sheetId: 'S', tabName: 'T2' }, 'unpaid') === false);
    t('★ 정산 요약이 아직 없으면 미입금으로 세지 않는다(모르면 세지 않는다)',
      m({ sheetId: 'S', tabName: 'T9' }, 'unpaid') === false);
    t('★ 인트라넷 실패(proxyDown)도 미입금으로 세지 않는다', (() => {
      sb.STATE.ownSettle['S\tT8'] = { proxyDown: true };
      return vm.runInContext('_ovmRowMatch', sb)({ sheetId: 'S', tabName: 'T8' }, 'unpaid', '') === false; })());
    t('마감 필터', m({ sheetId: 'S', tabName: 'T1', finished: true }, 'fin') === true);
    t('검색은 작업명·브랜드·상품·계약번호·비고를 본다',
      vm.runInContext('_ovmRowMatch', sb)({ sheetId: 'S', tabName: '넛세린_유산균', salesId: 'X' }, 'all', '유산균') === true
      && vm.runInContext('_ovmRowMatch', sb)({ sheetId: 'S', tabName: '넛세린', contractNumber: 'C-1' }, 'all', 'c-1') === true
      && vm.runInContext('_ovmRowMatch', sb)({ sheetId: 'S', tabName: '넛세린' }, 'all', '없는말') === false);
    // 094 동기화: 광고주가 지정한 브랜드명으로도 검색된다(작업명에 그 이름이 없어도)
    t('★ 검색은 광고주 지정 브랜드명도 본다',
      vm.runInContext('_ovmRowMatch', sb)({ sheetId: 'S', tabName: '넛세린_선스틱', brandName: '메이커스' }, 'all', '메이커스') === true
      && vm.runInContext('_ovmRowMatch', sb)({ sheetId: 'S', tabName: '넛세린_선스틱' }, 'all', '메이커스') === false);
  }

  // ★ 서버 finishCandidate ↔ 프론트 isFinishCandidate 등가 — 한쪽만 손대는 드리프트 차단
  {
    const sb = {}; vm.createContext(sb); vm.runInContext(grab('isFinishCandidate'), sb);
    const client = vm.runInContext('isFinishCandidate', sb);
    for (const st2 of [{ total: 100, submitted: 100, paid: 100 }, { total: 100, submitted: 99, paid: 100 },
      { total: 100, submitted: 100, paid: 99 }, { total: 0, submitted: 0, paid: 0 }, { total: 5 },
      { total: 10, submitted: 12, paid: 11 }, null, {}]) {
      assert.equal(client({ stats: st2 }), svc.finishCandidate(st2),
        '판정 등가: ' + JSON.stringify(st2));
    }
    t('★ 서버·프론트 마감 후보 판정이 실제로 같은 답을 낸다(현실 입력 8종)', true);
  }

  /* ═══ 7. 무신호 금지 + CSS 무결성 ═══ */
  console.log('\n7) 무신호 금지 · CSS 무결성');
  t('★ 통계·마감 실패 시 연결탭 표가 사유를 적는다', /ovm-warn[\s\S]{0,200}마감자료 검수/.test(HTML));
  t('★ 마감자료 검수 칩은 판정 불가면 비활성 + ?', /candKnown\?n\('cand'\):'\?'/.test(HTML) && /!candKnown/.test(HTML));
  t('★ 미입금 칩은 정산 요약 도착 전 …(0 으로 위장 금지)', /setlArrived\?n\('unpaid'\):'…'/.test(HTML));
  t('★ 개요 집계 실패 시 숫자를 ? 로 표기', /집계를 불러오지 못했습니다"\)>\?/.test(HTML) || /bad\?'\?'/.test(HTML));
  // ★★ 배지 규칙은 **실행**으로 본다 — grep 은 "집계 실패인데도 배지를 그리는" 변이를 통과시킨다(변이시험 실측).
  {
    const sb = { STATE: { advs: [], ovMeta: { ok: true }, advCur: null, role: 'admin' },
      _ovmAdvQ: '', _ovmAdvF: 'all', esc: v => String(v == null ? '' : v), _ovmHl: v => String(v == null ? '' : v),
      document: { querySelectorAll: () => [] } };
    const boxes = { '#advs': { innerHTML: '' }, '#ovmAdvChips': { innerHTML: '' } };
    sb.$ = sel => boxes[sel] || null;
    vm.createContext(sb);
    // 실제 헬퍼를 함께 올린다 — 배지 조건이 _ovmCandKnown 을 거치므로 플래그 로직까지 함께 실행된다.
    // ★ _isInternalRole 도 함께 올린다 — 업체 삭제(×) 버튼 게이트가 그 함수를 부른다(스텁을 두면
    //   역할 판정이 거기서만 딴판이 된다: workbarRecruitSort 가드의 WANT 목록과 같은 규율).
    vm.runInContext([grab('_isInternalRole'), grab('_ovmCandKnown'), grab('_ovmCandWhy'), grab('_ovmAdvMatch'), grab('_ovmRenderAdvs')].join('\n'), sb);
    const render = (advs, ovMeta) => { sb.STATE.advs = advs; sb.STATE.ovMeta = ovMeta;
      boxes['#advs'].innerHTML = ''; vm.runInContext('_ovmRenderAdvs()', sb); return boxes['#advs'].innerHTML; };
    const A = [{ id: 'A', name: '업체A', inadPm: 'AE', owned: 1, finishCand: 3 }, { id: 'B', name: '업체B', inadPm: 'AE', owned: 1, finishCand: 0 }];
    let html = render(A, { ok: true });
    t('마감자료 검수 대기가 있는 업체만 배지', (html.match(/ovm-b/g) || []).length === 1 && /">3<\/span>/.test(html), html.slice(0, 200));
    html = render(A, { ok: false });
    t('★ 집계 실패(ovMeta.ok=false)면 배지를 아예 그리지 않는다(0·임의 숫자로 위장 금지)',
      !/ovm-b/.test(html), html.slice(0, 200));
    html = render(A, { ok: true, statsUnavailable: true });
    t('★★ ok:true 인데 통계만 죽은 경우도 배지를 그리지 않는다(이 경로가 "0건"으로 위장되던 자리)',
      !/ovm-b/.test(html), html.slice(0, 200));
    html = render(A, { ok: true, finishedUnavailable: true });
    t('★ 마감 정보만 죽은 경우도 배지 미표시', !/ovm-b/.test(html));
    html = render([{ id: 'C', name: '업체C', inadPm: '', owned: 0, finishCand: 0 }], { ok: true });
    t('AE 미지정은 사이드바에서 경고색으로 표기', /class="pmn noae"/.test(html) && /AE 미지정/.test(html));
    t('★ 사이드바 행 onclick 은 인덱스만(업체명 문자열 주입 금지)', /onclick="selAdv\(0\)"/.test(html));
  }
  t('개요에 미입금 열을 두지 않는다(인트라넷 의존 — 대신 안내 문구)', /미입금 현황은 업체를 고르면/.test(HTML));
  // 신설 클래스는 ovm- 접두 — 기존 클래스 재정의 금지
  const cssBlock = (HTML.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [, ''])[1];
  const ovmSection = cssBlock.slice(cssBlock.indexOf('업체관리 리디자인(시안 A'), cssBlock.indexOf('.ovm-dbody .acc2col > .sect'));
  const selectors = (ovmSection.match(/^\s*\.[-\w.>\s,:()[\]="]+\{/gm) || []).map(x => x.trim());
  const bad = selectors.filter(sel => !/\.ovm-|\.advitem \.ovm-|\.own-panel|\.own-wrap/.test(sel));
  t('★ 신설 CSS 는 ovm- 접두만(기존 클래스 재정의 0 — 남의 화면이 조용히 무너진다)', bad.length === 0, JSON.stringify(bad).slice(0, 200));
  t('★ 이 뷰는 내부 스크롤(.own-wrap 고정 높이) — sticky 도구줄의 전제',
    /\.own-wrap\{display:grid;grid-template-columns:250px 1fr;height:calc\(100vh - var\(--toph/.test(cssBlock));
  t('★ 좁은 화면은 문서 스크롤로 복귀(고정 높이면 아래가 잘린다)', /@media\(max-width:780px\)\{\.own-wrap\{grid-template-columns:1fr;height:auto\}/.test(cssBlock));
  t('도구줄 sticky + 상단바를 덮지 않는 z-index', /\.ovm-tools\{position:sticky;top:-18px;z-index:3/.test(cssBlock));
  // 주석·중괄호 균형(주석 조기 종료는 규칙을 통째로 삼키고 브라우저는 에러 없이 넘어간다)
  const op = (cssBlock.match(/\/\*/g) || []).length, cl = (cssBlock.match(/\*\//g) || []).length;
  const stripped = cssBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  t('★ CSS 주석·중괄호 균형', op === cl && (stripped.match(/{/g) || []).length === (stripped.match(/}/g) || []).length,
    `주석 ${op}/${cl}`);
  const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let jsOk = true, jsErr = '';
  scripts.forEach(s2 => { try { new Function(s2); } catch (e) { jsOk = false; jsErr = e.message; } });
  t('★ 인라인 스크립트 파싱', jsOk, jsErr);

  console.log(`\n✅ ${pass} 케이스 통과\n`);
  process.exit(0);   // trackB.routes require 로 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구)
}
run().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
