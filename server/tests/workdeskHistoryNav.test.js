/**
 * workdeskHistoryNav.test.js — 통합 작업대 뒤로/앞으로(SPA 히스토리) 회귀가드.
 *
 * 문제였던 것: 업체관리에서 어떤 업체의 작업을 클릭하면 화면이 통째로 작업대로 바뀌는데
 *   히스토리에 아무것도 쌓이지 않아 **브라우저 뒤로가기가 통합 작업대를 벗어나** 버렸다
 *   (또는 아무 반응이 없었다). 화면이 바뀌었으면 뒤로/앞으로도 그 전환을 되짚어야 한다.
 *
 * 확정 규칙(완화 금지):
 *  - URL 은 건드리지 않는다(pathname+search 만) — #sso=/#adv=/#go= 프래그먼트 계약과 충돌 금지,
 *    주소를 공유해도 딥링크·PII 가 새지 않아야 한다. 같은 URL 로도 pushState 는 별개 항목이 된다.
 *  - 첫 항목은 push 가 아니라 **replace**(브라우저 최초 항목 state:null 을 낭비하면 뒤로가기 한 번이
 *    "아무 일도 안 일어나는" 헛클릭이 된다).
 *  - popstate 복원 중에는 재푸시 금지(_navLock) — 안 그러면 뒤로갈 때마다 항목이 다시 쌓여 못 빠져나온다.
 *  - 업체관리 연결탭 클릭·관측 '열기'처럼 pendingTab/pendingAdv 를 예약하는 흐름에서는
 *    switchView 가 쌓지 않는다 — 곧 selTab/selAdv 가 **최종 상태 1건**을 쌓기 때문(중간 항목을
 *    같이 쌓으면 뒤로가기를 두 번 눌러야 업체관리로 돌아간다 = 사용자가 신고한 증상의 재발).
 *
 * ★ grep 만으로는 못 잡는 부분(적재 순서·중복 억제·lock)은 실제 함수를 꺼내 **실행**해서 고정한다.
 *
 * 실행: node server/tests/workdeskHistoryNav.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── A. 배선(정적) ── */
ok('popstate 리스너가 있다', /addEventListener\('popstate'/.test(src));
ok('popstate 는 우리가 쌓은 항목(__wd)만 처리한다 — 외부 진입 항목은 브라우저에 양보',
  /if\(!st\|\|!st\.__wd\) return;/.test(src));
ok('로그인 화면(role 없음)에서는 복원하지 않는다', /if\(!STATE\.role\) return;[\s\S]{0,60}_navApply/.test(src));
ok('switchView 가 pendingTab/pendingAdv 예약 시에는 히스토리를 쌓지 않는다',
  /if\(!STATE\.pendingTab && !STATE\.pendingAdv\) _navPush\(\);/.test(src));
ok('selTab 이 복원 진입(opt.nav)이 아닐 때만 쌓는다',
  /async function selTab\(i, opt\)[\s\S]{0,260}if\(!\(opt&&opt\.nav\)\) _navPush\(\);/.test(src));
ok('selAdv 가 복원 진입(opt.nav)이 아닐 때만 쌓는다',
  /async function selAdv\(i, opt\)[\s\S]{0,320}if\(!\(opt&&opt\.nav\)\) _navPush\(\);/.test(src));
ok('loadTabs 가 pendingTab.__nav 를 selTab 으로 전달한다(복원 중 재적재 차단)',
  /const o=\{nav:!!pt\.__nav\};[\s\S]{0,240}selTab\(idx,o\)/.test(src));
ok('renderOwnershipView 가 pendingAdv 를 소비해 보던 업체 패널을 복원한다',
  /if\(STATE\.pendingAdv\)\{[\s\S]{0,240}selAdv\(ix,\{nav:!!pa\.__nav\}\); return;/.test(src));
ok('STATE 에 pendingAdv 초기값이 있다', /pendingTab:null, pendingAdv:null/.test(src));

/* ── B. 히스토리 항목 ↔ 실제 화면 일치(어긋나면 뒤로/앞으로가 없던 화면을 되살린다) ── */
ok('★ renderWorkdeskView: 열 작업 예약이 없으면 STATE.cur 를 비운다(본문이 "작업 선택" 안내로 뜨므로)',
  /function renderWorkdeskView\(\)\{[\s\S]{0,400}if\(!STATE\.pendingTab\) STATE\.cur=null;/.test(src));
ok('★ renderOwnershipView: 복원 진입이 아니면 STATE.advCur 를 비운다(화면은 업체추가로 뜨므로)',
  /async function renderOwnershipView\(\)\{[\s\S]{0,400}if\(!STATE\.pendingAdv\) STATE\.advCur=null;/.test(src));

/* ── C. URL 불변(프래그먼트 계약 보호) ── */
{
  const navBlock = /let _navLock=false;[\s\S]*?\n\}\);\n/.exec(src);
  ok('나브 블록을 찾았다', !!navBlock);
  const blk = navBlock[1] !== undefined ? navBlock[0] : navBlock[0];
  ok('★ push/replace 는 pathname+search 만 쓴다 — location.hash 를 URL 에 실지 않는다',
    !/location\.hash/.test(blk) && /location\.pathname\+location\.search/.test(blk));
  ok('★ URL 인자를 항상 넘긴다(생략하면 브라우저마다 상대경로 해석이 갈린다)',
    !/pushState\([^)]*\)\s*;/.test(blk.replace(/pushState\(e,'',url\)/g, 'X')) || /pushState\(e,'',url\)/.test(blk));
}

/* ── D. 런타임 실행 — 적재 순서·중복 억제·lock (grep 으로는 못 보는 것) ── */
{
  const m = /(let _navLock=false;[\s\S]*?)\nwindow\.addEventListener\('popstate'/.exec(src);
  assert(m, '나브 함수 블록 추출 실패');
  const entries = [];          // 브라우저 히스토리 흉내: [{state}]
  let idx = -1;
  const sandbox = {
    STATE: { view: 'workdesk', cur: null, advCur: null, pendingTab: null, pendingAdv: null },
    location: { pathname: '/workdesk.html', search: '', hash: '#sso=secret' },
    switchView: () => {},
    history: {
      get state() { return idx >= 0 ? entries[idx] : null; },
      pushState(s, _t, url) { entries.length = idx + 1; entries.push(s); idx = entries.length - 1; this.lastUrl = url; },
      replaceState(s, _t, url) { if (idx < 0) { entries.push(s); idx = 0; } else entries[idx] = s; this.lastUrl = url; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox);
  const { history: h, STATE: S } = sandbox;

  sandbox._navPush();
  ok('첫 항목은 replace — 항목이 1개만 생긴다(뒤로가기 헛클릭 방지)', entries.length === 1);
  ok('★ URL 에 해시가 실리지 않는다', h.lastUrl === '/workdesk.html');

  S.view = 'ownership'; sandbox._navPush();
  S.advCur = { id: 'A1' }; sandbox._navPush();
  ok('업체관리 진입 + 업체 선택 = 항목 2개 추가', entries.length === 3);

  sandbox._navPush();
  ok('★ 같은 화면 재적재는 항목을 늘리지 않는다(같은 nav 버튼 연타 = 뒤로가기 낭비)', entries.length === 3);

  S.view = 'workdesk'; S.cur = { sheetId: 'S1', tabName: '탭A', tabGid: '1' }; sandbox._navPush();
  ok('작업 열기 = 항목 1개 추가(총 4)', entries.length === 4);
  ok('작업 항목이 연 작업을 담는다', entries[3].tab && entries[3].tab.tabName === '탭A');
  ok('업체관리 항목이 선택 업체를 담는다', entries[2].advId === 'A1');
  ok('모든 항목에 __wd 표식이 있다(우리 항목만 복원)', entries.every(e => e.__wd === 1));

  // 뒤로가기 = _navApply — 복원 중에는 절대 다시 쌓이면 안 된다
  const before = entries.length;
  sandbox._navApply(entries[2]);
  ok('★ 복원(_navApply) 중에는 히스토리가 늘지 않는다', entries.length === before);
  ok('복원이 pendingAdv 를 예약한다(__nav 표식 포함)', S.pendingAdv && S.pendingAdv.id === 'A1' && S.pendingAdv.__nav === true);

  sandbox._navApply(entries[3]);
  ok('작업 항목 복원이 pendingTab 을 예약한다(__nav 표식 포함)',
    S.pendingTab && S.pendingTab.tabName === '탭A' && S.pendingTab.__nav === true);

  sandbox._navApply({ __wd: 1, view: 'workdesk' });
  ok('★ 탭 없는 작업대로 복원하면 열린 작업도 비운다(없던 작업이 열려 보이는 것 방지)',
    S.pendingTab === null && S.cur === null);

  // lock 이 복원 뒤 반드시 풀려야 한다(안 풀리면 이후 클릭이 영영 안 쌓인다)
  S.view = 'overview'; S.cur = null; S.advCur = null; sandbox._navPush();
  ok('★ 복원 뒤 _navLock 이 풀려 정상 적재가 다시 된다', entries[entries.length - 1].view === 'overview');
}

console.log(`\n✅ workdeskHistoryNav: ${n} cases passed`);
