/**
 * workdeskInspectView.test.js — 통합 작업대 "리뷰검수" 탭 무한로딩 회귀가드.
 *
 * 사고(신고): 리뷰검수 메뉴를 누르면 **영원히 "불러오는 중…"**. 서버가 죽은 것처럼 보였지만
 *   `GET /api/trackb/review-inspect/list` 는 **200 정상 응답**이었다.
 *   원인 = `_riRenderHead` 가 자기 스코프에 없는 `isAdmin` 을 참조(그 const 는 `renderNav` 안에만 있다)
 *   → 렌더가 ReferenceError → `_loadInspect` 의 promise 가 reject → 아무도 잡지 않아
 *   화면에 깔아 둔 "불러오는 중…" 자리표시자가 **그대로 남는다**. (#441 에서 [🖼 판별 예시]·
 *   [↻ 과거분 검수] 버튼을 추가하며 들어왔다.)
 *
 * ★★ 고정하는 것 두 가지 (완화 금지)
 *   ① 렌더 함수는 **자기 스코프 안에서** 역할을 다시 구한다 — 다른 함수의 const 에 기대지 않는다.
 *      (이 파일은 sandbox 에 `isAdmin` 전역을 **일부러 두지 않는다** — 프리변수가 다시 들어오면
 *       그 자리에서 ReferenceError 로 잡힌다. 전역을 두면 가드가 사고를 통과시킨다.)
 *   ② `_loadInspect` 는 **어떤 예외에도 화면을 종결**한다 — 조용히 매달리는 화면을 만들지 않는다.
 *      (fetch 실패·렌더 throw 어느 쪽이든 "불러오는 중…" 이 남으면 안 된다.)
 *
 * ★ grep 만으로는 못 잡는다: `isAdmin` 이라는 **문자열은 멀쩡히 있었고**, 문제는 그 식별자가
 *   그 스코프에서 해석되지 않는다는 것이었다 → 실제로 **실행**해서 고정한다.
 *
 * 실행: node server/tests/workdeskInspectView.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── A. 배선(정적) ───────────────────────────────────────────────────── */
const headFn = /function _riRenderHead\(sum\)\{[\s\S]*?\n\}/.exec(src);
ok('_riRenderHead 를 찾았다', !!headFn);
ok('★ _riRenderHead 가 isAdmin 을 자기 스코프에서 선언한다(다른 함수의 const 에 기대지 않는다)',
  /const isAdmin\s*=\s*STATE\.role===/.test(headFn[0]));
ok('_riRenderHead 는 여전히 관리자 전용 버튼을 isAdmin 으로 가린다(서버 adminOrMaster 와 1:1)',
  /isAdmin\?[\s\S]{0,80}riOpenSamples\(\)/.test(headFn[0]) && /isAdmin\?[\s\S]{0,80}riRunSweep\(\)/.test(headFn[0]));

const loadFn = /async function _loadInspect\(\)\{[\s\S]*?\n\}\nfunction _riRenderHead/.exec(src);
ok('_loadInspect 를 찾았다', !!loadFn);
ok('★ _loadInspect 가 try/catch 로 감싸져 있다(렌더 throw 가 화면을 매달지 못하게)',
  /try\{[\s\S]*\}catch\(/.test(loadFn[0]));
ok('★ catch 가 #ribody 를 종결한다 — "불러오는 중…" 자리표시자를 반드시 갈아치운다',
  /catch\([\s\S]{0,400}b\.innerHTML=/.test(loadFn[0]));
ok('진입 시 자리표시자는 그대로(로딩 표시 자체는 유지)',
  /async function renderInspectView\(\)\{[\s\S]{0,300}불러오는 중/.test(src));

/* ── B. 런타임 실행 — 프리변수·무한로딩을 실제로 재현·차단 ─────────────── */
const block = /const _RI_LABEL = \{[\s\S]*?\n(?=\/\*\* 카드의 탭명을 눌러)/.exec(src);
ok('리뷰검수 렌더 블록을 추출했다', !!block);

/** 아주 작은 DOM 흉내 — innerText 대신 innerHTML 문자열만 본다. */
function makeSandbox(role, api) {
  const els = { '#rihead': { innerHTML: '' }, '#ribody': { innerHTML: '<div class="empty">불러오는 중…</div>' }, '#viewroot': { innerHTML: '' } };
  const sandbox = {
    STATE: { role, riStatus: 'open', riTab: null },
    els,
    $: (s) => els[s] || null,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    api,
    API_BASE: 'https://api.example',
    _riSyncNavBadge: () => {},
    console,
    // ★ isAdmin 전역을 **두지 않는다** — 프리변수가 다시 들어오면 여기서 터져야 한다.
  };
  vm.createContext(sandbox);
  vm.runInContext(block[0], sandbox);
  return sandbox;
}

const ITEMS = [
  {
    file_id: 'AAAAAAAAAAAAAAAAAAAAAAAA', sheet_id: 's1', tab_name: '7/3(쿠팡)테스트탭', row_index: 12,
    reviewer_name: '김리뷰', status: 'fail', channel: 'coupang',
    checks: { format: { verdict: 'fail' }, duplicate: { verdict: 'fail', matchTab: '다른탭', matchReviewer: '박씨', matchRow: 3 } },
  },
  // 값이 비어 있는 행도 같은 렌더러를 탄다(널 안전)
  { file_id: 'BBBBBBBBBBBBBBBBBBBBBBBB', sheet_id: 's1', tab_name: '7/3(쿠팡)테스트탭', row_index: null, reviewer_name: null, status: 'pending', checks: null },
];
const OKRES = { ok: true, items: ITEMS, summary: { pass: 1, suspect: 2, fail: 3, pending: 4 }, openCount: 5, scoped: false };

(async () => {
  // B-1. 정상 렌더 — 이게 원래 사고 지점(200 응답인데 화면이 안 넘어갔다).
  //   ★ "오류 문구가 안 뜬다"까지 봐야 한다: fail-soft catch 가 생긴 뒤로는 렌더가 throw 해도
  //     화면이 종결되므로, 종결 여부만 보면 프리변수 회귀를 통과시킨다.
  for (const role of ['master', 'admin', 'staff']) {
    const sb = makeSandbox(role, async () => JSON.parse(JSON.stringify(OKRES)));
    await vm.runInContext('_loadInspect()', sb);
    const body = sb.els['#ribody'].innerHTML, head = sb.els['#rihead'].innerHTML;
    ok(`[${role}] ★ "불러오는 중…" 이 남지 않는다(무한로딩 재발 차단)`, !/불러오는 중/.test(body));
    ok(`[${role}] ★ 정상 응답에 오류 문구가 뜨지 않는다(렌더가 실제로 완주했다)`, !/표시하지 못했습니다/.test(body));
    ok(`[${role}] 카드가 그려진다`, /class="ricard/.test(body));
    ok(`[${role}] 헤더가 그려진다`, /리뷰검수/.test(head));
    const adminBtns = /riOpenSamples\(\)/.test(head) && /riRunSweep\(\)/.test(head);
    if (role === 'staff') ok('[staff] 관리자 전용 버튼(판별 예시·과거분 검수)은 안 보인다(서버 게이트와 1:1)', !adminBtns);
    else ok(`[${role}] 관리자 전용 버튼이 보인다`, adminBtns);
  }

  // B-2. 렌더가 throw 해도 화면은 종결된다 (원래 사고의 일반형)
  {
    const sb = makeSandbox('master', async () => JSON.parse(JSON.stringify(OKRES)));
    vm.runInContext('_riRenderBody = function(){ throw new Error("강제 렌더 오류"); }', sb);
    await vm.runInContext('_loadInspect()', sb);
    ok('★ 렌더가 throw 해도 "불러오는 중…" 이 남지 않는다', !/불러오는 중/.test(sb.els['#ribody'].innerHTML));
    ok('★ 무슨 일이 났는지 화면이 말해 준다(조용한 실패 금지)', /표시하지 못했습니다/.test(sb.els['#ribody'].innerHTML));
    ok('★ 다시 시도할 길을 준다', /_loadInspect\(\)/.test(sb.els['#ribody'].innerHTML));
  }

  // B-3. fetch 자체가 실패해도 종결된다
  {
    const sb = makeSandbox('master', async () => { throw new TypeError('Failed to fetch'); });
    await vm.runInContext('_loadInspect()', sb);
    ok('★ 네트워크 실패에도 "불러오는 중…" 이 남지 않는다', !/불러오는 중/.test(sb.els['#ribody'].innerHTML));
    ok('네트워크 실패 사유가 화면에 보인다', /Failed to fetch/.test(sb.els['#ribody'].innerHTML));
  }

  // B-4. 서버가 ok:false 로 거절해도 종결된다(기존 동작 유지)
  {
    const sb = makeSandbox('staff', async () => ({ ok: false, error: '담당하지 않은 작업(스코프 밖)' }));
    await vm.runInContext('_loadInspect()', sb);
    ok('거절 응답도 화면을 종결한다', !/불러오는 중/.test(sb.els['#ribody'].innerHTML));
    ok('거절 사유를 그대로 보여준다', /스코프 밖/.test(sb.els['#ribody'].innerHTML));
    ok('거절 시에도 헤더는 그려진다(필터·새로고침으로 빠져나갈 수 있게)', /리뷰검수/.test(sb.els['#rihead'].innerHTML));
  }

  // B-5. 빈 목록
  {
    const sb = makeSandbox('master', async () => ({ ok: true, items: [], summary: { pass: 0, suspect: 0, fail: 0, pending: 0 }, openCount: 0 }));
    await vm.runInContext('_loadInspect()', sb);
    ok('빈 목록도 종결 문구로 끝난다', /검수 건이 없습니다/.test(sb.els['#ribody'].innerHTML));
  }

  console.log(`\n✅ workdeskInspectView: ${n}개 통과`);
})().catch(e => { console.error('❌ 실패:', e.message); process.exit(1); });
