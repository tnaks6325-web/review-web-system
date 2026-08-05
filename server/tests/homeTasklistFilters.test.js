/**
 * homeTasklistFilters.test.js — 홈 작업목록 개선 3종 회귀가드
 * 실행: node tests/homeTasklistFilters.test.js
 * 시안: frontend/docs/design-home-tasklist-improvements.html (v3, 사용자 확정)
 *
 * 이 변경에서 깨지면 아픈 것 다섯.
 *  ① **헤더 고정 상쇄 CSS** — 전역 table{overflow:hidden}이 .wbl-t 의 sticky 를 무효화한다(실브라우저
 *     실측으로 잡은 원인). overflow:visible 상쇄가 사라지면 sticky 선언이 있어도 헤더가 다시 흐른다.
 *  ② **필터 판정 단일 출처** — 목록과 스위치 건수가 _finMatchFilter 한 곳을 봐야 하고, 마감 체크는
 *     isFinishCandidate **그대로**여야 한다(사본이 생기면 배지와 목록이 갈린다). vm 으로 실제 실행해 고정.
 *  ③ **헤더 칸 수 ≡ 행 칸 수** — 열을 끼워 넣을 때 가장 흔하게 깨지는 자리(계약 매칭 가드 선례).
 *     실제 렌더 결과에서 센다.
 *  ④ **현영 비활성 = 숨김 아님**(사용자 확정) — 숨기면 줄마다 버튼 수가 달라져 열이 어긋난다.
 *  ⑤ **tab-folders = find-only** — 여기서 폴더를 만들면 생성 경로(업로드·스마트빌드)가 두 벌이 된다.
 *     가짜 Drive 로 라우트를 실제 호출해 create 미호출을 고정.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 홈 작업목록 개선 3종 회귀가드\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const ROUTES = S('src/routes/trackB.routes.js');
const SVC_SRC = S('src/services/trackB.service.js');

/* ── 0) 가짜 Drive 를 **라우터 require 전에** 심는다(라우트가 지연 require 로 집는다) ── */
const drivePath = require.resolve('../src/services/drive.service');
const driveCalls = { find: [], create: 0 };
let driveFound = null;   // 케이스별로 바꿔 끼우는 findFolderByName 결과
require.cache[drivePath] = {
  id: drivePath, filename: drivePath, loaded: true, exports: {
    extractFolderIdFromUrl: u => { const m = String(u || '').match(/folders\/([-\w]+)/); return m ? m[1] : null; },
    findFolderByName: async (name, parent) => { driveCalls.find.push([name, parent]); return driveFound; },
    // find-only 계약 — 아래 중 무엇이든 불리면 그 자리에서 실패
    createFolder: async () => { driveCalls.create++; throw new Error('create 호출됨'); },
    getOrCreateSubFolder: async () => { driveCalls.create++; throw new Error('create 호출됨'); },
    ensureFolderPath: async () => { driveCalls.create++; throw new Error('create 호출됨'); },
  },
};

/* ── 1) 헤더행 고정 — 상쇄 CSS 토큰(선언 존재가 아니라 **무효화 원인의 상쇄**를 본다) ── */
console.log('1) 헤더행 고정 CSS');
t('전역 table{…overflow:hidden} 은 그대로다(다른 화면의 둥근 모서리가 의존 — 계약 확인)',
  /\n\s*table\{[^}]*overflow:hidden\}/.test(WD));
t('★ .wbl-t 가 전역 규칙을 상쇄(overflow:visible) — 이게 빠지면 sticky 기준이 표 자신이 되어 무효',
  /table\.wbl-t\{[^}]*overflow:visible/.test(WD));
t('★ border-collapse:separate + border-spacing:0(collapse 는 th 경계선이 본문과 함께 밀린다)',
  /table\.wbl-t\{[^}]*border-collapse:separate;border-spacing:0/.test(WD));
t('th 는 sticky + 경계선을 box-shadow 로', /table\.wbl-t th\{[^}]*position:sticky[^}]*box-shadow:0 1px 0 var\(--line\)/.test(WD));
t('목록 높이 640px(사용자 확정 Q3)', /\.wbl-tw\{max-height:640px/.test(WD));

/* ── 2) 필터 판정 + 렌더 — vm 실제 실행 ─────────────────────────── */
console.log('\n2) 필터 판정 · 렌더 (vm 실행)');
const s0 = WD.indexOf('function _finVisible(){');
const s1 = WD.indexOf('const WT_CAP=12;');
assert(s0 > 0 && s1 > s0, '홈 목록 블록 추출 실패');
const BLOCK = WD.slice(s0, s1);
t('★ 마감 체크는 isFinishCandidate 그대로(판정 사본 금지)', /f==='cand'\) return isFinishCandidate\(t\)/.test(BLOCK));

const candCalls = [];
const hero = { textContent: '' };
const host = { innerHTML: '' };
const sandbox = {
  STATE: { tabs: [], finTab: 'run', finMgr: '', finQ: '', finFilter: '' },
  isFinished: t2 => !!(t2 && t2.finished),
  isTodayDone: t2 => !!(t2 && t2.todayDone),
  isFinishCandidate: t2 => { candCalls.push(t2); const s = t2 && t2.stats; return !!(s && s.total && (s.submitted | 0) >= s.total && (s.paid | 0) >= s.total); },
  _finCanEdit: () => true,
  _finDate: v => String(v || ''),
  esc: v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  toast: () => {}, api: async () => ({ ok: true }),
  window: {}, console,
  document: { getElementById: id => id === 'wblMount' ? host : (id === 'hmStTabs' ? hero : null) },
};
vm.createContext(sandbox);
vm.runInContext(BLOCK, sandbox, { filename: 'wbl-block.js' });

const TAB = (o) => Object.assign({ sheetId: 'S1', advertiserName: '업체', campaigns: [], stats: {} }, o);
const tOpen = TAB({ tabName: '모집중탭', campaigns: [{ id: 'c1', state: 'open' }], stats: { manager: '만두', total: 10, submitted: 8, paid: 5, folderUrl: 'https://drive.google.com/drive/folders/aaa', captureFolderUrl: 'https://drive.google.com/drive/folders/bbb', cashReceipt: true } });
const tNone = TAB({ tabName: '공고없는탭', stats: { manager: '망고', total: 10, submitted: 10, paid: 10, cashReceipt: false } });
const tDone = TAB({ tabName: '오늘완료탭', todayDone: true, campaigns: [{ id: 'c2', state: 'open' }], stats: { total: 5, submitted: 1, paid: 0, cashReceipt: false } });
const tClosed = TAB({ tabName: '마감공고탭', campaigns: [{ id: 'c3', state: 'closed' }], stats: { total: 5, submitted: 3, paid: 3, cashReceipt: false } });

t('금일 진행 = 오늘 완료 미체크 ∧ 공고 모집중(Q1 확정)', sandbox._finMatchFilter(tOpen, 'today') === true);
t('오늘 완료 체크된 작업은 금일 진행에서 빠진다', sandbox._finMatchFilter(tDone, 'today') === false);
t('공고가 마감이면 금일 진행 아님', sandbox._finMatchFilter(tClosed, 'today') === false);
t('공고 자체가 없으면 금일 진행 아님(정의상 판정 불가)', sandbox._finMatchFilter(tNone, 'today') === false);
t('레거시 공고는 status active 를 모집중으로(카드 점 색과 같은 _campRank 판정)',
  sandbox._finMatchFilter(TAB({ campaigns: [{ id: 'l', state: 'legacy', status: 'active' }] }), 'today') === true);
t('입금 체크 = 제출 > 입금', sandbox._finMatchFilter(tOpen, 'pay') === true && sandbox._finMatchFilter(tNone, 'pay') === false);
t('통계 없는 작업은 입금 체크에 안 잡힌다(0 으로 꾸미지 않음)', sandbox._finMatchFilter(TAB({ stats: null }), 'pay') === false);
candCalls.length = 0;
t('마감 체크가 isFinishCandidate 를 실제로 부른다(위임 실행 확인)',
  sandbox._finMatchFilter(tNone, 'cand') === true && candCalls.length === 1);

// _finVisible: pay 필터는 미입금 큰 순
sandbox.STATE.tabs = [tNone, tClosed, tOpen];   // unpaid: 0, 0, 3
sandbox.STATE.finFilter = 'pay';
let vis = sandbox._finVisible();
t('pay 필터 = 미입금 있는 작업만 + 미입금 큰 순', vis.length === 1 && vis[0].tabName === '모집중탭');
sandbox.STATE.tabs = [tClosed, tOpen];
sandbox.STATE.finFilter = '';
vis = sandbox._finVisible();
t('필터 해제 = 전체(기존 동작 그대로)', vis.length === 2);

// 같은 칸 재클릭 = 해제
sandbox.STATE.finFilter = 'pay';
sandbox._finPickFilter('pay');
t('같은 칸 재클릭 = 해제', sandbox.STATE.finFilter === '');
sandbox._finPickFilter('cand');
t('다른 칸 클릭 = 전환', sandbox.STATE.finFilter === 'cand');
sandbox.STATE.finFilter = '';

/* 렌더 — 헤더 칸 수 ≡ 행 칸 수, 현영 비활성 표시, 스위치 */
sandbox.STATE.tabs = [tOpen, tNone];
sandbox._finRenderList();
const html = host.innerHTML;
const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
const thCount = (thead.match(/<th[>\s]/g) || []).length;   // <thead 오계수 방지
const tb = html.indexOf('<tbody>');
const firstRow = html.slice(tb, html.indexOf('</tr>', tb));   // 헤더의 </tr> 을 집지 않게 tbody 뒤에서 탐색
const tdCount = (firstRow.match(/<td/g) || []).length;
t(`★ 헤더 칸 수 ≡ 행 칸 수 (${thCount})`, thCount === tdCount && thCount === 10, `th=${thCount} td=${tdCount}`);
t('v3 헤더열 — 작업표·저장폴더·모집공고·오늘완료·마감이 독립 열',
  /<th class="wbl-c">작업표<\/th>/.test(thead) && /저장폴더/.test(thead) && /모집공고/.test(thead) && /오늘완료/.test(thead) && /<th class="wbl-c">마감<\/th>/.test(thead));
t('작업표 열이 작업명↔담당 사이(사용자 확정)', /작업명<\/th><th class="wbl-c">작업표<\/th><th>담당/.test(thead.replace(/\s+/g, '')) || /작업명[\s\S]{0,40}작업표[\s\S]{0,40}담당/.test(thead));
t('히어로 "진행 중 작업" 단일 writer 유지', hero.textContent === '2');
// 현영 비활성(사용자 확정): 숨기지 않고 옅은색 + 클릭 불가 + 사유
const rowNone = html.slice(html.indexOf('공고없는탭'), html.indexOf('</tr>', html.indexOf('공고없는탭')));
t('★ 현영 비해당도 버튼이 **존재**한다(숨김 회귀 차단)', />현영<\/button>/.test(rowNone));
t('★ 비활성 = dis 클래스 + disabled + 사유 툴팁', /class="wbl-b dis" disabled[^>]*현금영수증 발행 대상 작업이 아닙니다[^>]*>현영</.test(rowNone));
const rowOpen = html.slice(html.indexOf('모집중탭'), html.indexOf('</tr>', html.indexOf('모집중탭')));
t('현영 탭은 활성 버튼', /openTabFolder\(\d+,'receipt'\)/.test(rowOpen));
t('구매·리뷰는 저장 URL 로 활성', /openTabFolder\(\d+,'capture'\)/.test(rowOpen) && /openTabFolder\(\d+,'review'\)/.test(rowOpen));
t('★ onclick 은 인덱스만(시트발 문자열 보간 금지 — M1 실측 XSS 규율)',
  !/openTabFolder\('/.test(WD) && !/openTabFolder\(\$\{[^}]*tabName/.test(WD));
t('폴더 URL 은 Drive 호스트만 연다', /_folUrlOk/.test(BLOCK) && /https:\\\/\\\/drive\\\.google\\\.com/.test(BLOCK.match(/function _folUrlOk[\s\S]{0,200}/)[0]));
// 스위치(진행 중 탭 전용) — 건수는 목록과 같은 판정
t('3분할 토글 스위치 렌더(금일 진행·입금 체크·마감 체크)',
  /wbl-sw/.test(html) && /금일 진행 1/.test(html) && /입금 체크 1/.test(html) && /마감 체크 1/.test(html));
t('해제 상태 = 썸 없음(off)', /wbl-sw off/.test(html));
// pay 필터 켜면 썸 이동 + 미입금 병기
sandbox.STATE.finFilter = 'pay';
sandbox._finRenderList();
t('필터 켜짐 = 썸 위치(중앙 104px)', /<i style="left:104px">/.test(host.innerHTML));
t('입금 체크 중엔 미입금 건수를 빨간 병기', /\(미입금 3\)/.test(host.innerHTML));
// today 필터의 정의상 한계 고지(조용한 누락 금지)
sandbox.STATE.finFilter = 'today';
sandbox._finRenderList();
t('★ 공고 없는 작업 N건 미표시 고지(Q1 의 귀결)', /모집공고가 없는 작업 1건은 \[금일 진행\] 필터에 표시되지 않습니다/.test(host.innerHTML));
// 조회 실패 = 무신호 금지(칸 비활성 + '?')
sandbox.STATE.finFilter = '';
sandbox.STATE.statsUnavailable = true;
sandbox._finRenderList();
t('★ 통계 실패 시 입금·마감 칸 비활성 + ? (빈 결과로 위장 금지)',
  (host.innerHTML.match(/disabled[^>]*>(💰 입금 체크|🏁 마감 체크) \?/g) || []).length === 2);
sandbox.STATE.statsUnavailable = false;
// 마감 보관함에서는 스위치·필터 미적용
sandbox.STATE.finTab = 'fin';
sandbox.STATE.finFilter = 'pay';
sandbox.STATE.tabs = [TAB({ tabName: '끝난탭', finished: true, finishedAt: '2026-08-01' })];
sandbox._finRenderList();
t('보관함에는 스위치 없음 + 필터 무시', !/wbl-sw/.test(host.innerHTML) && /끝난탭/.test(host.innerHTML));
const finTb = host.innerHTML.indexOf('<tbody>');
t('보관함 행도 칸 수 동일(빈 칸 유지 — 열 수가 사람·모드마다 달라지지 않는다)',
  (host.innerHTML.slice(finTb, host.innerHTML.indexOf('</tr>', finTb)).match(/<td/g) || []).length === 10);
sandbox.STATE.finTab = 'run'; sandbox.STATE.finFilter = '';
t('탭 전환이 필터를 초기화한다', (sandbox._finPickTab('fin'), sandbox.STATE.finFilter === ''));

/* ── 3) 서버 stats 배선 — tabStatsMap 실제 실행(스텁 pool) ────────── */
console.log('\n3) tabStatsMap 폴더 필드 (서비스 실행)');
t('SELECT 에 folder_url·capture_folder_url·income_type(tab_configs 를 이미 읽는 쿼리 — 순증 0)',
  /tc\.folder_url AS "folderUrl", tc\.capture_folder_url AS "captureFolderUrl", tc\.income_type AS "incomeType"/.test(SVC_SRC));
t('★ 현영 판정은 captureSlots.isCashReceiptIncome 재사용(사본 금지)',
  /require\('\.\.\/utils\/captureSlots'\)/.test(SVC_SRC) && /cashReceipt: isCashReceiptIncome\(r\.incomeType\)/.test(SVC_SRC));
const svc = require('../src/services/trackB.service');
(async () => {
  svc.__setPoolForTest({
    query: async () => ({ rows: [
      { sheetId: 'S1', tabName: '현영탭', manager: '만두', campaignName: '', displayName: '', folderUrl: 'https://drive.google.com/drive/folders/r1', captureFolderUrl: 'https://drive.google.com/drive/folders/c1', incomeType: '사업자현영', rowCount: 10, submittedCount: 5, paidCount: 2, closeoutDate: null, closeoutRows: null },
      { sheetId: 'S1', tabName: '실배송탭', manager: '망고', campaignName: '', displayName: '', folderUrl: null, captureFolderUrl: null, incomeType: '실배송', rowCount: 3, submittedCount: 1, paidCount: 0, closeoutDate: null, closeoutRows: null },
    ] }),
  });
  const r = await svc.tabStatsMap({ force: true });
  const m1 = r.map['S1\t현영탭'], m2 = r.map['S1\t실배송탭'];
  t('폴더 URL·현영 여부가 stats 맵에 실린다', m1.folderUrl && m1.captureFolderUrl && m1.cashReceipt === true);
  t('실배송 탭은 cashReceipt:false + 폴더 null', m2.cashReceipt === false && m2.folderUrl === null);
  svc.__setPoolForTest(null);

  /* ── 4) GET /tab-folders — 라우터 스택 실검사 + 실제 호출(find-only) ── */
  console.log('\n4) GET /tab-folders (라우트 실행)');
  const router = require('../src/routes/trackB.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/tab-folders');
  t('라우트 등록됨', !!layer);
  const names = layer.route.stack.map(s => s.name);
  t('★ authMiddleware 가 맨 앞 + internalMiddleware(광고주 차단) — 무인증·광고주 도달 불가',
    names[0] === 'authMiddleware' && names[1] === 'internalMiddleware', names.join(','));
  t('★ 라우트 소스가 find-only(생성 함수 미참조 — 폴더 생성 경로는 업로드·스마트빌드 하나)',
    !/tab-folders'[\s\S]{0,3000}(getOrCreateSubFolder|ensureFolderPath|createFolder)/.test(ROUTES));
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const pool = require('../src/db/pool');
  const origQuery = pool.query;
  let tabRow = null;
  pool.query = async () => ({ rows: tabRow ? [tabRow] : [] });
  const call = async (query, admin) => {
    let out, status = 200;
    const res = { status(c) { status = c; return this; }, json(o) { out = o; } };
    await handler({ query, admin: admin || { role: 'admin', name: 't' } }, res);
    return { out, status };
  };
  // ① 파라미터 누락
  let r4 = await call({});
  t('파라미터 누락 = 200 + 사유(fail-soft)', r4.out.ok === false);
  // ② 현영 아님
  tabRow = { folder_url: 'https://drive.google.com/drive/folders/rv1', capture_slots: null, income_type: '실배송' };
  r4 = await call({ sheetId: 'S1', tabName: 'A' });
  t('현영 아님 = 거부 + Drive 미호출', r4.out.ok === false && /발행 대상/.test(r4.out.error) && driveCalls.find.length === 0);
  // ③ 현영 + 발견 → URL (라벨 = captureSlots 단일 규칙의 '현금영수증')
  tabRow = { folder_url: 'https://drive.google.com/drive/folders/rv2', capture_slots: null, income_type: '사업자현영' };
  driveFound = { id: 'sub1', webViewLink: 'https://drive.google.com/drive/folders/sub1' };
  r4 = await call({ sheetId: 'S1', tabName: 'B' });
  t('현영 탭 = [리뷰] 하위 현금영수증 서브폴더 URL 반환',
    r4.out.ok === true && r4.out.url === 'https://drive.google.com/drive/folders/sub1');
  t('★ find 는 리뷰 폴더 ID 를 부모로, 라벨은 현금영수증(업로드 서브폴더와 같은 규칙)',
    driveCalls.find.length === 1 && driveCalls.find[0][0] === '현금영수증' && driveCalls.find[0][1] === 'rv2');
  t('★ find-only — create 류 호출 0(여기서 만들면 생성 경로가 두 벌)', driveCalls.create === 0);
  // ③-b 캐시 — 같은 탭 재요청은 Drive 재조회 없음
  r4 = await call({ sheetId: 'S1', tabName: 'B' });
  t('발견 URL 은 캐시(재클릭에 Drive 콜 0)', r4.out.ok === true && driveCalls.find.length === 1);
  // ④ 미발견 = 안내(생성하지 않음 — Q2 확정)
  tabRow = { folder_url: 'https://drive.google.com/drive/folders/rv3', capture_slots: null, income_type: '현영' };
  driveFound = null;
  r4 = await call({ sheetId: 'S1', tabName: 'C' });
  t('미발견 = "현영 캡처가 아직 없어…" 안내(만들지 않는다)',
    r4.out.ok === false && /현영 캡처가 아직 없어/.test(r4.out.error) && driveCalls.create === 0);
  // ⑤ 리뷰 폴더 자체가 없으면 그 사유를 말한다
  tabRow = { folder_url: null, capture_slots: null, income_type: '현영' };
  r4 = await call({ sheetId: 'S1', tabName: 'D' });
  t('리뷰 폴더 없음 = 자동 생성 시점 안내', r4.out.ok === false && /리뷰 폴더가 아직 없습니다/.test(r4.out.error));
  // ⑥ staff 스코프 — 담당 밖 탭은 403(폴더 URL 도 스코프 밖으로 새지 않는다)
  const origScope = svc.canAccessTab;
  svc.canAccessTab = async () => false;
  r4 = await call({ sheetId: 'S1', tabName: 'E' }, { role: 'staff', name: 'AE1' });
  t('★ staff 담당 밖 = 403(마감·스레드와 같은 스코프 규율)', r4.status === 403 && r4.out.ok === false);
  svc.canAccessTab = origScope;
  // ⑦ DB 예외 = fail-soft 200
  pool.query = async () => { throw new Error('db down'); };
  r4 = await call({ sheetId: 'S1', tabName: 'F' });
  t('DB 예외도 200 + 사유(fail-soft — 클릭 한 번에 500 금지)', r4.status === 200 && r4.out.ok === false);
  pool.query = origQuery;

  /* ── 5) 광고주 미동봉(폴더 URL 은 내부 정보) ─────────────────────── */
  console.log('\n5) 광고주 격리');
  t('stats(폴더 URL 포함) 주석은 role!==advertiser 블록 안에서만 실린다',
    /if \(role !== 'advertiser'\) \{[\s\S]{0,900}tabStatsMap/.test(S('src/routes/trackB.routes.js')));

  console.log(`\n✅ ${pass} 케이스 통과`);
  process.exit(0);   // trackB.routes require 로 열린 pool 핸들 종료(레포 관용구)
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
