/**
 * workdeskHome.test.js — 리뷰웹시스템[3버전] 첫 진입 홈(시안 B 타일 런처형 · ① nav 상시 유지) 회귀가드.
 * 시안 문서 = frontend/docs/design-workdesk-home.html
 *
 * ★★ 고정하는 것 (완화 금지)
 *   ① 홈은 **읽기 전용 + 이동**만 — 타일·브리핑 줄 클릭 = switchView 뿐, 처리 로직 사본 0.
 *   ② 숫자는 전부 기존 nav 뱃지 재료(_NAVCS·_NAVLG·_NAVRI·STATE.woCounts)와 같은 값 —
 *      각 *SyncNavBadge 가 _homeSyncBadges 를 불러 수렴한다(홈 전용 집계 금지).
 *      #woNavBadge 표기는 _woSyncNavBadge 한 곳뿐(홈/작업오더 뷰 어느 쪽이 갱신하든 같은 함수).
 *   ③ 신규 API 0 — 홈이 부르는 경로는 기존 3개(tabs·campaigns/list·work-orders/list)뿐.
 *   ④ 조회 실패/미도착 칸은 '?'·'–' (0 으로 꾸미지 않는다 — 조용한 정상 위장 금지).
 *   ⑤ 광고주는 홈 미도달(nav 자체가 없다) — data-v="home" 버튼은 admin·staff 두 nav 에만.
 *   ⑥ 렌더는 자기 스코프에서 역할을 다시 구한다 — sandbox 에 isAdmin 전역을 **일부러 두지 않아**
 *      프리변수가 들어오면 그 자리에서 ReferenceError(리뷰검수 무한로딩 실측 사고의 재발 차단).
 *
 * 실행: node server/tests/workdeskHome.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── A. 배선(정적) ───────────────────────────────────────────────────── */
console.log('A. 배선');

ok('★ data-v="home" nav 버튼이 정확히 2곳(admin·staff) — 광고주 진입로 없음',
  (src.match(/data-v="home"/g) || []).length === 2);
{
  const navs = [...src.matchAll(/<nav class="nav">([\s\S]*?)<\/nav>/g)].map(m => m[1]);
  ok('두 nav 모두 홈 버튼이 작업보드보다 앞(첫 메뉴)',
    navs.length >= 2 && navs.every(h => {
      const hi = h.indexOf('data-v="home"'), wi = h.indexOf('data-v="workdesk"');
      return hi >= 0 && wi >= 0 && hi < wi;
    }));
}
ok('★ 기본 뷰 = 홈(내부인) / 광고주는 workdesk(전용 대시보드) 유지',
  /switchView\(STATE\.view\|\|\(isAdv\?'workdesk':'home'\)\)/.test(src));
ok('switchView 가 home → renderHomeView 분기', /v==='home'\)\s*renderHomeView\(\)/.test(src));

ok('★ _loadOrders 는 _woSyncNavBadge() 를 부른다(인라인 표기 사본 제거)',
  /_renderWoHead\(\); _renderWoBody\(\);\s*\n\s*_woSyncNavBadge\(\);/.test(src));
ok('★ #woNavBadge 표기는 _woSyncNavBadge 안 한 곳뿐(값 단일 출처)',
  (src.match(/#woNavBadge/g) || []).length === 1);

for (const fn of ['_renderCsNavBadge', '_lgSyncNavBadge', '_riSyncNavBadge', '_woSyncNavBadge']) {
  const m = new RegExp('function ' + fn + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}').exec(src);
  ok(`★ ${fn} 가 _homeSyncBadges 를 부른다(홈=뱃지 값 단일 출처)`,
    m && /_homeSyncBadges/.test(m[0]));
}
ok('★ _riSyncNavBadge 가 _NAVRI.n 에 값을 기억한다(DOM 되읽기 금지)',
  /function _riSyncNavBadge\(n\)\{[\s\S]{0,220}_NAVRI\.n=n/.test(src));
ok('logout 이 _NAVRI 도 초기화한다(이전 계정 건수 잔류 방지)', /_NAVRI\.n=null/.test(src));

/* 홈 블록 추출 — _hmMenus 부터 '홈 끝' 마커까지 */
const homeBlock = /function _hmMenus\(\)\{[\s\S]*?\/\* ══ 홈 끝 ══ \*\//.exec(src);
ok('홈 블록(_hmMenus~홈 끝)을 찾았다', !!homeBlock);
const HB = homeBlock[0];

{
  const paths = [...HB.matchAll(/api\('([^']+)'\)/g)].map(m => m[1]);
  // ★ tabs 는 stats=1 을 달고 나간다(홈 "작업 목록" 블록의 담당자·인원/제출·입금 재료 — migration 088).
  //   엔드포인트 **개수는 그대로 3개**라 이 검사의 의미(신규 API 0)는 불변 — 배선 형태가 바뀌었으니 패턴만 갱신한다.
  const allow = ['/api/trackb/tabs?limit=300&stats=1', '/api/trackb/campaigns/list', '/api/trackb/work-orders/list?status=submitted'];
  ok('★ 신규 API 0 — 홈이 부르는 경로는 기존 3개뿐: ' + paths.join(', '),
    paths.length === 3 && paths.every(p => allow.includes(p)));
  ok('홈 블록에 fetch/POST 없음(읽기 전용)', !/fetch\(/.test(HB) && !/method\s*:\s*'POST'/i.test(HB));
}
ok('★ 타일·브리핑 줄 클릭 = switchView 이동뿐(처리 로직 사본 0)',
  (HB.match(/onclick="switchView\('/g) || []).length >= 2 && !/onclick="(?!switchView)/.test(HB));
ok('★ _hmMenus 가 역할을 자기 스코프에서 구한다(프리변수 금지)',
  /function _hmMenus\(\)\{[\s\S]{0,300}const isAdmin\s*=\s*STATE\.role===/.test(HB));
ok('★ renderHomeView 도 역할을 자기 스코프에서 구한다',
  /function renderHomeView\(\)\{[\s\S]{0,200}const isAdmin\s*=\s*STATE\.role===/.test(HB));

/* 홈 CSS — hm- 접두만(기존 클래스 충돌 금지) */
{
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)[1];
  const cssBlock = /\/\* ══ 홈\(첫 진입\)[\s\S]*?(?=<\/style>|$)/.exec(style);
  ok('홈 CSS 블록을 찾았다', !!cssBlock);
  const rules = cssBlock[0].replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [...rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map(m => m[2].trim()).filter(Boolean);
  // ★ 이 검사의 의미 = "새 선택자는 전용 접두를 써서 남의 화면을 오염시키지 않는다".
  //   holdover: 홈 아래 작업 목록 블록(migration 088)은 wbl- 접두를 쓴다 — 접두를 늘리는 것은 의미 불변,
  //   대신 **접두 없는 일반 선택자**(.card, table 같은 것)는 여전히 금지된다.
  // holdover ②: 이 블록 추출은 `/* ══ 홈(첫 진입)` 부터 `</style>` 끝까지를 통째로 집으므로, 그 뒤에
  //   덧붙은 **오버레이 전용 스타일**(`#abOv …`·`#rnOv …`·`#ddOv …`·`#hbOv …`)까지 함께 들어온다.
  //   그것들도 "전용 스코프를 쓴다"는 이 검사의 의미를 지키고 있으므로(오버레이 id 로 스코프), 허용한다.
  //   ★ 여전히 금지되는 것은 **스코프 없는 일반 선택자**(`.card`·`table`·`th` 같은 것)다.
  const SCOPED = /^(#hmwrap|\.hm-|\.wbl-|table\.wbl-|#[A-Za-z][\w-]*Ov[\s.:[#>]|#[A-Za-z][\w-]*Ov$)/;
  ok('★ 홈 CSS 선택자는 전부 전용 스코프(#hmwrap/.hm-/.wbl- 또는 오버레이 #…Ov): ' + sels.length + '개',
    sels.length > 5 && sels.every(s => s.split(',').every(p => SCOPED.test(p.trim()))),
    sels.filter(s => s.split(',').some(p => !SCOPED.test(p.trim()))).join(' | '));
}

/* ── B. 런타임(vm) — 실제 실행으로 프리변수·표시 규칙 고정 ─────────────── */
console.log('B. 런타임');

function makeSandbox(role, apiImpl) {
  const els = {};
  const reg = id => els[id] || (els[id] = { id, textContent: '', style: {} });
  const viewroot = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = v;
      // id 등록 + 마크업의 초기 텍스트('?'·'–')를 textContent 로 — 실제 DOM 파싱의 최소 재현
      for (const m of v.matchAll(/id="([A-Za-z0-9_]+)"[^>]*>([^<]*)</g)) reg(m[1]).textContent = m[2].trim();
      for (const m of v.matchAll(/id="([A-Za-z0-9_]+)"/g)) reg(m[1]);
    },
  };
  els.hmDummyNever = undefined; // 안전
  const sb = {
    console, Promise, Number, Array, String, Date, Object,
    STATE: { role, name: '테스터', woCounts: null },
    _NAVCS: { cs: null, re: null },
    _NAVLG: { rv: null, sys: null },
    _NAVRI: { n: null },                       // 실제로는 홈 블록 밖 최상위 const — 여기서는 스텁으로 공급
    esc: s => String(s == null ? '' : s),
    switchView: () => {},
    api: apiImpl || (() => Promise.resolve(null)),
    document: { getElementById: id => (id === 'viewroot' ? viewroot : els[id] || null) },
    $: sel => { const id = String(sel).replace(/^#/, ''); return id === 'viewroot' ? viewroot : els[id] || null; },
    // isAdmin 전역은 **일부러 없다** — 프리변수가 들어오면 ReferenceError 로 그 자리에서 터진다.
  };
  sb._woSyncNavBadge = () => { sb._homeSyncBadges && sb._homeSyncBadges(); }; // 블록 밖 함수 — nav 표기 없이 홈 동기화만
  // 홈 아래 "작업 목록" 블록의 렌더러(블록 밖 함수, migration 088). **일부러 아무것도 쓰지 않는 스파이** —
  //   히어로 "진행 중 작업"을 여기서만 쓴다는 계약이 깨지면(=_homeLoad 가 직접 쓰면) 아래 단언이 잡는다.
  sb._finRenderListCalls = [];
  sb._finRenderList = () => { sb._finRenderListCalls.push((sb.STATE.tabs || []).length); };
  sb.isFinished = t => !!(t && t.finished);
  // 목록 응답 흡수(블록 밖 함수) — 여기서는 "응답의 tabs 를 STATE.tabs 에 싣는다"는 계약만 재현한다.
  //   (실패 플래그를 덮지 않는 규율 자체는 workboardFinish 가드 + 실브라우저 검증이 담당)
  sb._finAbsorb = r => { (r.tabs || []).forEach(n => { if (!sb.STATE.tabs.some(x => x === n)) sb.STATE.tabs.push(n); }); };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(HB.replace(/\/\* ══ 홈 끝 ══ \*\//, ''), sb);
  // function 선언을 sandbox 프로퍼티로 노출(vm 컨텍스트 최상위 = sb)
  return { sb, els, viewroot };
}

(async () => {
  { // 1. master 렌더 — 전체 타일 + 문의 줄, 실패 칸 '?' 유지
    const { sb, els, viewroot } = makeSandbox('master');
    vm.runInContext('renderHomeView()', sb);
    const h = viewroot._html;
    ok('master: 전 메뉴 타일(등록리뷰어DB·관측·입금관리 포함)이 그려진다',
      ['작업보드', '작업오더', '모집공고', 'C/S', '리뷰검수', '로그', '업체관리', '관측', '입금관리', '등록리뷰어DB', '업무가이드', '설정'].every(t => h.includes(t)));
    ok('master: 미확인 문의 브리핑 줄이 있다', h.includes('미확인 문의') && !!els.hmBrCs);
    await new Promise(r => setTimeout(r, 0));
    ok('★ api 실패(null) — 히어로 숫자가 0 이 아니라 ? 로 남는다',
      els.hmStTabs.textContent === '?' && els.hmStOpen.textContent === '?' && els.hmStNeed.textContent === '?');
    ok('★ 미도착 브리핑 줄은 – 로 남는다(0 으로 꾸미지 않음)', els.hmBrWo.textContent === '–');
  }
  { // 2. staff(AE) 렌더 — admin 전용 타일·문의 줄 없음, 프리변수 0
    const { viewroot } = makeSandbox('staff');
    const sb2 = makeSandbox('staff'); vm.runInContext('renderHomeView()', sb2.sb);
    const h = sb2.viewroot._html;
    // ★ 2026-08 사용자 확정: 관측은 AE 도 본다(서버 /overview·/parity 가 internal) — 타일도 함께 열었다.
    //   입금관리·등록리뷰어DB 는 여전히 adminOrMaster 라 타일이 없어야 한다(눌러도 403 인 막다른 길 금지).
    ok('staff: admin 전용 타일(입금관리·등록리뷰어DB)이 없다 — nav 정책과 1:1',
      !h.includes('등록리뷰어DB') && !h.includes('입금관리'));
    ok('staff: 관측 타일은 있다(서버 게이트 internal 과 1:1)', h.includes('Track B 전환 현황'));
    ok('staff: 미확인 문의 줄이 없다(AE 는 문의 미열람 — 영원한 – 방지)', !h.includes('미확인 문의'));
    ok('staff: 공통 타일(작업보드·C/S·리뷰검수)은 있다', h.includes('작업보드') && h.includes('리뷰검수'));
    void viewroot;
  }
  { // 3. 뱃지 값 도착 → 타일·브리핑·확인 필요 합계(값 단일 출처)
    const { sb, els } = makeSandbox('master');
    vm.runInContext('renderHomeView()', sb);
    sb._NAVCS.cs = 5; sb._NAVCS.re = 11; sb._NAVRI.n = 4;
    sb._NAVLG.rv = 2; sb._NAVLG.sys = 1; sb.STATE.woCounts = { submitted: 2 };
    vm.runInContext('_homeSyncBadges()', sb);
    ok('★ 확인 필요 = 도착한 값의 합(2+16+4+3=25)', els.hmStNeed.textContent === '25');
    ok('타일 뱃지 = nav 합산과 같은 값(C/S 16)', els.hmCsBadge.textContent === '16' && els.hmCsBadge.style.display === '');
    ok('브리핑 줄은 성분값(문의 5건 / 교체요청 11건)', els.hmBrCs.textContent === '5건' && els.hmBrRe.textContent === '11건');
    ok('작업오더 타일 뱃지·브리핑 줄(2)', els.hmWoBadge.textContent === '2' && els.hmBrWo.textContent === '2건');
  }
  { // 4. 부분 도착 — 0 값 타일은 숨김, 합계는 아는 값만
    const { sb, els } = makeSandbox('master');
    vm.runInContext('renderHomeView()', sb);
    sb._NAVRI.n = 0;
    vm.runInContext('_homeSyncBadges()', sb);
    ok('0 건 타일 뱃지는 숨김(nav 표기 규칙과 동일)', els.hmRiBadge.style.display === 'none');
    ok('★ 부분 도착 합계 = 아는 값만(0) — 나머지는 여전히 –', els.hmStNeed.textContent === '0' && els.hmBrCs.textContent === '–');
  }
  { // 5. _homeLoad 성공 경로 — 기존 응답 계약(ok/data/state/ops·counts) 그대로 소비
    const apiImpl = p => {
      // 마감 1건 포함 — "진행 중"은 마감을 뺀 수라는 새 계약(088)의 재료
      if (p.startsWith('/api/trackb/tabs')) return Promise.resolve({ ok: true, tabs: [{}, {}, { finished: true }] });
      if (p.startsWith('/api/trackb/campaigns/list')) return Promise.resolve({ ok: true, data: [
        { state: 'open' }, { status: 'active' },                                  // 참여형 open + 레거시 active
        { state: 'cutoff', ops: { todaySubmitted: 7 } }, { state: 'open', ops: { todaySubmitted: 3 } },
        { status: 'draft' },                                                      // 레거시 비활성 — 미계수
      ] });
      if (p.startsWith('/api/trackb/work-orders/list')) return Promise.resolve({ ok: true, counts: { submitted: 4 } });
      return Promise.resolve(null);
    };
    const { sb, els } = makeSandbox('master', apiImpl);
    vm.runInContext('renderHomeView()', sb);
    await vm.runInContext('_homeLoad()', sb);
    // ★ 히어로 "진행 중 작업"의 writer 는 _finRenderList 한 곳(migration 088) — _homeLoad 는 재료만 넘긴다.
    //   두 곳에서 세면 마감 직후 히어로 3 · 목록 [진행 중] 2 로 갈린다(브라우저 검증이 실제로 잡은 회귀).
    ok('★ _homeLoad 는 히어로 숫자를 직접 쓰지 않는다(단일 writer 계약)', els.hmStTabs.textContent === '?');
    // (renderHomeView 자체가 _homeLoad 를 부르므로 이 하네스에서는 호출이 2회 — 횟수가 아니라 "위임했는가"를 본다)
    ok('★ tabs 응답을 STATE.tabs 에 실어 작업 목록 렌더러에 위임(같은 재료 = 숫자가 갈릴 수 없다)',
      sb._finRenderListCalls.length >= 1 && sb._finRenderListCalls.every(n => n === 3)
      && Array.isArray(sb.STATE.tabs) && sb.STATE.tabs.length === 3);
    ok('모집중 공고 = 참여형 open(2) + 레거시 active(1) = 3', els.hmStOpen.textContent === '3');
    ok('오늘 참여 확정 = ops.todaySubmitted 합(10)', els.hmStToday.textContent === '10');
    ok('★ 작업오더 수는 STATE.woCounts 에 실려 _woSyncNavBadge 경유(값 단일 출처)', els.hmBrWo.textContent === '4건');
  }
  { // 6. api reject — _homeLoad 가 조용히 완료(unhandled rejection 0), '?' 유지
    const { sb, els } = makeSandbox('master', () => Promise.reject(new Error('네트워크')));
    vm.runInContext('renderHomeView()', sb);
    await vm.runInContext('_homeLoad()', sb);
    ok('★ 전 호출 실패에도 _homeLoad 는 정상 완료 + ? 유지(fail-soft)', els.hmStTabs.textContent === '?');
  }
  { // 7. 홈이 안 떠 있으면 no-op — 다른 뷰에서 뱃지 갱신이 홈 코드로 죽지 않는다
    const { sb } = makeSandbox('master');
    vm.runInContext('_homeSyncBadges()', sb);   // 렌더 없이 호출
    ok('홈 미표시 상태의 _homeSyncBadges 는 무해(no-op)', true);
  }

  console.log(`\n✅ workdeskHome: ${n} cases passed`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
