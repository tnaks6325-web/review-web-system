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
const driveCalls = { find: [], receiptFind: [], create: 0 };
let driveFound = null;   // 케이스별로 바꿔 끼우는 findFolderByName 결과
require.cache[drivePath] = {
  id: drivePath, filename: drivePath, loaded: true, exports: {
    extractFolderIdFromUrl: u => { const m = String(u || '').match(/folders\/([-\w]+)/); return m ? m[1] : null; },
    findFolderByName: async (name, parent) => { driveCalls.find.push([name, parent]); return driveFound; },
    findReceiptFolderPath: async (root, sheetId, tabName, label) => {
      driveCalls.receiptFind.push([root, sheetId, tabName, label]);
      return driveFound;
    },
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
/* ★ 라벨 단일 출처(_tabLabel/_tabTip/_tabSearchText)는 이 블록 밖에 선언돼 있다.
   **스텁이 아니라 구현을 넣는다** — 스텁을 두면 그 함수의 회귀를 여기서만 못 본다(레포 규율). */
const _grabFn = name => {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\([^\\n]*\\n?').exec(WD);
  assert(m, 'workdesk.html 에서 ' + name + ' 을 찾지 못했다');
  const st = WD.indexOf('{', m.index + name.length + 10);
  let d = 0, i = st;
  for (; i < WD.length; i++) { const c = WD[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  return WD.slice(m.index, i + 1) + '\n';
};
const LABEL_SRC = ['_tabLabel', '_tabTip', '_tabSearchText'].map(_grabFn).join('');
const BLOCK = LABEL_SRC + WD.slice(s0, s1);
t('★ 마감 체크는 isFinishCandidate 그대로(판정 사본 금지)', /f==='cand'\) return isFinishCandidate\(t\)/.test(BLOCK));

const candCalls = [];
const hero = { textContent: '' };
const host = { innerHTML: '' };
let bodyEl = null;   // #wblBody — 검색이 갱신하는 조각(아래 IME 절에서 붙인다)
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
  // ★ 검색이 본문만 갈아 끼우는지 보려면 #wblBody 를 **실제로 갖고 있어야** 한다(없으면 폴백 경로만 검사하게 된다).
  document: { getElementById: id => id === 'wblMount' ? host : (id === 'hmStTabs' ? hero : (id === 'wblBody' ? bodyEl : null)) },
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
t(`★ 헤더 칸 수 ≡ 행 칸 수 (${thCount})`, thCount === tdCount && thCount === 14, `th=${thCount} td=${tdCount}`);
// 2026-08-19 사용자 확정: 목록에서 바로 공유 주소를 복사하는 [🔗 링크] 열이 작업표 옆에 붙었다.
t('공유 열이 작업표 바로 뒤(작업표=내가 연다 / 공유=남에게 보낸다)',
  /작업표<\/th>\s*<th[^>]*>공유<\/th>/.test(thead));
t('v3 헤더열 — 작업표·저장폴더·모집공고·오늘완료·마감이 독립 열',
  /<th class="wbl-c">작업표<\/th>/.test(thead) && /저장폴더/.test(thead) && /모집공고/.test(thead) && /오늘완료/.test(thead) && /<th class="wbl-c">마감<\/th>/.test(thead));
t('작업표 열이 작업명↔담당 사이(사용자 확정)', /작업명[\s\S]{0,60}작업표[\s\S]{0,60}담당/.test(thead));
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
t('입금 체크 중엔 미입금 건수를 눈에 보이게 병기(시안 확정 2026-09-22: 상자 주황 + 남은 수 상시 표시)',
  /class="rest on">3명 남음/.test(host.innerHTML) && /class="box short/.test(host.innerHTML));
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
  (host.innerHTML.slice(finTb, host.innerHTML.indexOf('</tr>', finTb)).match(/<td/g) || []).length === 14);
sandbox.STATE.finTab = 'run'; sandbox.STATE.finFilter = '';
t('탭 전환이 필터를 초기화한다', (sandbox._finPickTab('fin'), sandbox.STATE.finFilter === ''));

/* ── 2.5) 한글 IME 조합 — 검색은 **본문만** 다시 그린다 ──────────────────────────
   사용자 신고: 검색칸에 '면' 을 치면 'ㅁㅕㄴ' 으로 쪼개졌다. 원인은 입력 한 글자마다
   _finRenderList 가 헤더까지 innerHTML 로 교체해 **입력칸 DOM 이 재생성**되면서 브라우저의
   조합 상태가 파괴된 것. 그래서 여기서는 "검색 시 host(=헤더 포함 껍데기)가 그대로인가"를 본다
   — 문자열 grep 으로는 못 잡고(호출은 여전히 있으니), **실행해서 DOM 이 안 갈리는지** 봐야 한다. */
console.log('\n2.5) 한글 IME 조합 (검색 = 본문만 갱신)');
sandbox.STATE.finTab = 'run'; sandbox.STATE.finFilter = ''; sandbox.STATE.finQ = '';
sandbox.STATE.tabs = [tOpen, tNone];
sandbox._finRenderList();
t('전체 렌더는 본문을 #wblBody 로 감싼다(검색이 갈아 끼울 지점)', /<div id="wblBody">/.test(host.innerHTML));
// ★ 높이 고정(아래 2.6)을 **실제로 실행해 보려면** stub 이 style·offsetHeight 를 갖고 있어야 한다.
//   offsetHeight 는 호출 순서를 기록하는 getter — "교체 전에 읽는가"·"한 번만 읽는가"를 본다.
const hRead = [];
bodyEl = { innerHTML: '', style: {},
  get offsetHeight(){ hRead.push(this.innerHTML); return hRead.length === 1 ? 640 : 100; } };
const shellBefore = host.innerHTML;
const heroBefore = hero.textContent;
sandbox._finSearch('모집');
t('★ 검색은 헤더(입력칸 포함) DOM 을 재생성하지 않는다 — IME 조합 파괴 원인 제거',
  host.innerHTML === shellBefore, '검색 후 host.innerHTML 이 바뀌었다(입력칸 재생성 = 조합 끊김)');
t('★ 검색 결과는 #wblBody 에만 반영된다', /모집중탭/.test(bodyEl.innerHTML) && !/공고없는탭/.test(bodyEl.innerHTML));
t('검색 상태는 STATE.finQ 에 남는다(재렌더 시 값 유지)', sandbox.STATE.finQ === '모집');
t('히어로 숫자는 검색과 무관(all 기준 — 흔들리지 않는다)', hero.textContent === heroBefore);
// 자모 단위(조합 중간값)로도 죽지 않아야 한다 — 조합 중 input 이벤트가 실제로 이 값들을 보낸다
sandbox._finSearch('ㅁ');
t('조합 중간값(자모)에도 예외 없이 본문만 갱신', host.innerHTML === shellBefore && /조건에 맞는 작업이 없습니다/.test(bodyEl.innerHTML));
sandbox._finSearch('');
t('검색어를 지우면 전체 복귀', /모집중탭/.test(bodyEl.innerHTML) && /공고없는탭/.test(bodyEl.innerHTML));
t('★ 재생성 후 focus/커서 복구 코드는 제거됐다(조합을 되살리지 못하는 우회책 — 부활 금지)',
  !/setSelectionRange/.test(WD.slice(WD.indexOf('function _finSearch'), WD.indexOf('function _finSearch') + 600)));
t('★ 본문 조각은 한 벌 — 전체 렌더와 검색이 같은 _finBodyHtml 을 쓴다(사본 금지)',
  (WD.match(/function _finBodyHtml\(/g) || []).length === 1 && (WD.match(/_finBodyHtml\(\)/g) || []).length >= 2);

/* ── 2.6) 검색 중 화면 흔들림 — 본문 바깥 높이를 붙잡는다 ───────────────────────
   사용자 신고(2026-09-21): "검색하는 과정에서 화면이 위아래로 흔들린다". 실측 원인 = 한글 조합
   중간값(`ㅁ`·`모ㅈ`)에서 결과가 0건이 되어 **한 글자를 치는 동안에도** 목록 상자 높이가
   "0건 ↔ N건" 을 왕복 → 아래 빠른메뉴가 밀리고 스크롤이 위로 클램프돼 화면이 튄다(530px).
   ★ 그래서 "줄어들고 늘어나는 것은 목록(행)뿐" 이어야 한다 — 바깥 높이는 검색 내내 불변. */
console.log('\n2.6) 검색 중 높이 고정 (화면 흔들림)');
sandbox.STATE.finQ = ''; sandbox.STATE._finBodyH = 0;
bodyEl.style = {}; hRead.length = 0; bodyEl.innerHTML = '검색전본문';
sandbox._finSearch('모집');
t('★ 검색을 시작하면 그 시점 본문 높이를 min-height 로 고정한다', bodyEl.style.minHeight === '640px');
t('★ 높이는 innerHTML 교체 **전에** 읽는다(교체 후엔 이미 줄어든 높이라 의미가 없다)',
  hRead.length === 1 && hRead[0] === '검색전본문', '교체 후에 읽었거나 여러 번 읽었다');
sandbox._finSearch('ㅁ');
t('★★ 조합 중간값(0건)에도 고정값을 다시 재지 않는다 — 재측정하면 작은 높이로 굳어 흔들림이 부활',
  bodyEl.style.minHeight === '640px' && hRead.length === 1);
t('그래도 목록(행)은 정상적으로 줄어든다(고정은 바깥 높이만)', /조건에 맞는 작업이 없습니다/.test(bodyEl.innerHTML));
sandbox._finSearch('');
t('★ 검색어를 비우면 고정 해제(빈 공간을 남기지 않는다)',
  bodyEl.style.minHeight === '' && !(sandbox.STATE._finBodyH > 0));
sandbox._finSearch('모집');
t('다시 검색하면 그때 높이로 새로 고정한다', bodyEl.style.minHeight === '100px');
sandbox._finRenderList();
t('★ 전체 렌더는 고정을 해제한다(화면을 새로 그리는 시점 — 다음 입력이 새로 잡는다)',
  !(sandbox.STATE._finBodyH > 0));
t('★ 헤더는 여전히 재생성되지 않는다(2.5 의 IME 계약 유지)', /<div id="wblBody">/.test(host.innerHTML));
t('★ 고정값 판정은 STATE 한 곳(사본 금지)', (WD.match(/_finBodyH/g) || []).length >= 3);

/* ── 2.7) 모바일(≤720px) — "스크롤이 튀지 않을 만큼만" 고정 ─────────────────────
   사용자 확정 2026-09-21(2차): 휴대폰도 흔들리지 않게. 그쪽은 `.wbl-tw{max-height:none}` 라
   목록이 문서에 통째로 펼쳐져(실측 3257px) **전체를 고정하면 빈 공간이 수천 px** 이 된다.
   → 지금 보고 있는 스크롤 위치가 살아남을 만큼만 고정한다(필요 없으면 0 = 빈 공간 0).
   ★ 모드는 CSS(`--wblfix`)가 정한다 — 브레이크포인트 사본을 JS 에 만들지 않는다.
   실측(390×844·작업 40개): 검색창을 보며 타이핑=0px(고정 불필요) · 중간까지 내린 상태 1260px→1px
   · 맨 아래 3187px→1px. */
console.log('\n2.7) 모바일 fit 모드 (스크롤이 튀지 않을 만큼만)');
const SC = { scrollTop: 0, clientHeight: 794, scrollHeight: 4649 };   // 실측값(844 화면 − 상단 50)
let bodyH = 3257;                                                     // 펼쳐진 목록 높이(실측)
bodyEl = { innerHTML: '', style: {}, get offsetHeight(){ return bodyH; }, closest: () => SC };
sandbox.getComputedStyle = () => ({ getPropertyValue: () => 'fit' });
sandbox.STATE.finQ = ''; sandbox.STATE._finBodyH = 0; sandbox.STATE._finBodyGap = null;

// ① 검색창을 보며 타이핑하는 정상 사용 = 여유가 충분 → 고정하지 않는다(빈 공간 0)
SC.scrollTop = 479;
sandbox._finSearch('모집');
t('★★ 여유가 충분하면 고정하지 않는다(빈 공간 0 — 정상 사용에서 화면 불변)',
  bodyEl.style.minHeight === '' && !(sandbox.STATE._finBodyH > 0));

// ② 많이 내려본 상태 = 필요한 만큼만(전체 3257 이 아니라 1330)
sandbox._finSearch(''); SC.scrollTop = 1928;
sandbox._finSearch('모집');
t('★★ 여유가 모자라면 "스크롤이 살아남을 만큼만" 고정한다(전체가 아니다)',
  bodyEl.style.minHeight === '1330px', '실제: ' + bodyEl.style.minHeight);
t('★ 전체 고정(펼쳐진 목록 높이)이 아니다 — 그랬다면 빈 공간이 수천 px', sandbox.STATE._finBodyH < bodyH);

// ③ 결과가 0건이 되어 본문이 줄어도 고정값을 다시 재지 않는다(재측정하면 그 순간 튄다)
bodyH = 90;
sandbox._finSearch('ㅁ');
t('★ 조합 중간값(0건)에도 고정값이 줄지 않는다', sandbox.STATE._finBodyH === 1330);

// ④ 스크롤을 더 내린 뒤 검색어를 고치는 경우 → 키운다(줄이면 그 순간 튄다)
SC.scrollTop = 2600;
sandbox._finSearch('모집2');
t('★★ 더 내려간 뒤 고치면 필요한 만큼 키운다(줄이지 않는다)', sandbox.STATE._finBodyH === 2002);
SC.scrollTop = 100;
sandbox._finSearch('모집3');
t('★ 다시 올라가도 줄이지 않는다(줄이는 순간 그 자리에서 튄다)', sandbox.STATE._finBodyH === 2002);

// ⑤ 검색어를 비우면 전부 해제
sandbox._finSearch('');
t('★ 검색어를 비우면 고정·기준값 모두 해제', bodyEl.style.minHeight === '' &&
  !(sandbox.STATE._finBodyH > 0) && sandbox.STATE._finBodyGap === null);

// ⑥ 모드를 못 읽으면 데스크톱(full)로 접는다
sandbox.getComputedStyle = () => { throw new Error('no css'); };
bodyH = 640;
sandbox._finSearch('모집');
t('★ 모드를 못 읽으면 full — 종전(데스크톱) 동작이 기본',
  bodyEl.style.minHeight === '640px');
sandbox._finSearch('');
delete sandbox.getComputedStyle;

t('★★ CSS 가 모드를 정한다 — 기본 full · 모바일 미디어쿼리에서 fit(브레이크포인트 사본 금지)',
  /#wblBody\{[^}]*--wblfix:full/.test(WD) && /@media\(max-width:720px\)/.test(WD) && /#wblBody\{--wblfix:fit/.test(WD));
t('★★ 모바일에서 min-height 를 !important 로 막지 않는다(막으면 fit 고정이 무시돼 흔들림이 부활)',
  !/#wblBody\{[^}]*min-height:0!important/.test(WD));
t('★ 스크롤 컨테이너를 못 찾아도 죽지 않는다(문서 스크롤 폴백)',
  /document\.scrollingElement/.test(WD));

bodyEl = null;   // 이후 절은 전체 렌더 경로를 그대로 검사한다
sandbox.STATE.finQ = ''; sandbox.STATE._finBodyH = 0;

/* ── 3) 서버 stats 배선 — tabStatsMap 실제 실행(스텁 pool) ────────── */
console.log('\n3) tabStatsMap 폴더 필드 (서비스 실행)');
t('SELECT 에 folder_url·capture_folder_url·income_type(tab_configs 를 이미 읽는 쿼리 — 순증 0)',
  /tc\.folder_url AS "folderUrl", tc\.capture_folder_url AS "captureFolderUrl", tc\.income_type AS "incomeType"/.test(SVC_SRC));
// ★ 현영 판정은 captureSlots 유틸 재사용(사본 금지). 규칙은 hasCashReceiptSlot 하나로 통일됐다 —
//   /tab-folders 가 폴더를 해석할 때 쓰는 것과 **같은 함수**여야 "눌리는데 거부"가 안 생긴다.
t('★ 현영 판정은 captureSlots.hasCashReceiptSlot 재사용(사본 금지)',
  /require\('\.\.\/utils\/captureSlots'\)/.test(SVC_SRC)
  && /cashReceipt: hasCashReceiptSlot\(r\.captureSlots, r\.incomeType, r\.cashReceiptRequired === true\)/.test(SVC_SRC)
  && /SELECT BOOL_OR\(rc\.cash_receipt_required\) FROM recruit_campaigns rc/.test(SVC_SRC));
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
  t('현영 탭 = 비공개 현금영수증 폴더 URL 반환',
    r4.out.ok === true && r4.out.url === 'https://drive.google.com/drive/folders/sub1');
  t('★ find 는 업로드와 같은 비공개 경로 helper + 실제 슬롯 라벨을 사용',
    driveCalls.receiptFind.length === 1
    && driveCalls.receiptFind[0][1] === 'S1' && driveCalls.receiptFind[0][2] === 'B'
    && driveCalls.receiptFind[0][3] === '현금영수증');
  t('★ find-only — create 류 호출 0(여기서 만들면 생성 경로가 두 벌)', driveCalls.create === 0);
  // ③-b 캐시 — 같은 탭 재요청은 Drive 재조회 없음
  r4 = await call({ sheetId: 'S1', tabName: 'B' });
  t('발견 URL 은 캐시(재클릭에 Drive 콜 0)', r4.out.ok === true && driveCalls.receiptFind.length === 1);
  // ④ 미발견 = 안내(생성하지 않음 — Q2 확정)
  tabRow = { folder_url: 'https://drive.google.com/drive/folders/rv3', capture_slots: null, income_type: '현영' };
  driveFound = null;
  r4 = await call({ sheetId: 'S1', tabName: 'C' });
  t('미발견 = "현영 캡처가 아직 없어…" 안내(만들지 않는다)',
    r4.out.ok === false && /현영 캡처가 아직 없어/.test(r4.out.error) && driveCalls.create === 0);
  // ⑤ 리뷰 폴더가 없어도 영수증은 별도 비공개 경로에서 찾는다
  tabRow = { folder_url: null, capture_slots: null, income_type: '현영' };
  driveFound = { id: 'private1', webViewLink: 'https://drive.google.com/drive/folders/private1' };
  r4 = await call({ sheetId: 'S1', tabName: 'D' });
  t('리뷰 폴더가 없어도 비공개 현영 폴더 바로가기는 동작', r4.out.ok === true && /private1/.test(r4.out.url));
  // ⑥ AE(staff) 범위 — ★★ **사용자 확정 2026-08-19: AE 는 담당이 아니어도 전부 연다.**
  //   종전 이 자리는 "담당 밖 = 403" 을 고정했지만, 그때 이미 `/workdesk`(작업보드 본문)·`/tabs`
  //   (작업 목록)가 `allowAllStaff` 로 전체를 열어 주고 있어 **폴더 버튼만 막는 반쪽 규칙**이었다.
  //   지금은 라우트가 그 사실을 주석으로 못박고 있고(“staff는 작업보드 전체 운영 권한”), 이 가드도
  //   같은 규칙을 고정한다. ★ 좁히기로 되돌린다면 `/workdesk`·`/tabs`·공유 링크와 **함께** 좁혀야 한다.
  //   ★ 남은 경계는 **광고주 차단**이고 그것은 핸들러가 아니라 라우터 단계(internalMiddleware)가 맡는다
  //     — 아래에서 미들웨어가 핸들러보다 앞에 있음을 스택으로 고정한다(캐시가 그 앞을 우회할 수 없다).
  tabRow = { folder_url: 'https://drive.google.com/drive/folders/rv9', capture_slots: null, income_type: '현영' };
  driveFound = { id: 'sub9', webViewLink: 'https://drive.google.com/drive/folders/sub9' };
  const warm = await call({ sheetId: 'S1', tabName: 'E' });
  t('캐시 워밍(admin) 성공', warm.out.ok === true && /sub9/.test(warm.out.url || ''));
  r4 = await call({ sheetId: 'S1', tabName: 'E' }, { role: 'staff', name: 'AE1' });
  t('★★ AE 는 담당이 아니어도 연다 — 캐시된 탭에서도 작업보드와 같은 규칙(사용자 확정)',
    r4.status === 200 && r4.out.ok === true && /sub9/.test(r4.out.url || ''));
  t('★ 담당 스코프 판정을 이 라우트가 따로 만들지 않는다(작업보드와 갈리는 두 번째 기준 금지)',
    !/tab-folders'[\s\S]{0,2600}canAccessTab/.test(ROUTES));
  {
    const idxInternal = names.indexOf('internalMiddleware');
    t('★ 광고주 차단은 라우터 단계 — internalMiddleware 가 핸들러보다 앞(캐시가 그 앞을 우회할 수 없다)',
      idxInternal > -1 && idxInternal < names.length - 1, names.join(','));
  }
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
