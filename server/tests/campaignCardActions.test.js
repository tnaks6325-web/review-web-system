/**
 * campaignCardActions.test.js — 모집공고 카드 액션 줄(시안 C) 회귀가드.
 *
 * 배경(사용자 신고 2026-08-07): 액션 버튼이 6개로 늘면서 카드 UI가 깨졌다.
 *   실측 = 카드 266px → 액션 줄 244px → 「게시」 토글 57px 고정 → 버튼 하나에 27px,
 *   그런데 라벨은 35~48px 필요 = 6개 전부 넘치고 마지막 버튼이 토글과 겹쳤다.
 * 확정안(시안 C) = **주 버튼 3개(수정·보기·관제) + [⋯] 더보기**, 나머지는 메뉴로.
 *
 * 여기서 고정하는 것:
 *   ① 주 줄에 버튼이 다시 늘어나지 않는다(늘리려면 [⋯] 안으로)
 *   ② 메뉴는 **body 직속** — `.pcard{overflow:hidden}` 안에 그리면 통째로 잘린다
 *   ③ 리스너는 최상위 1회만(열 때마다 걸면 겹쳐 쌓인다)
 *   ④ 항목을 고르면 메뉴가 닫힌다 — 항목 onclick 이 stopPropagation 을 하므로
 *      document 리스너로는 못 닫는다(**캡처 단계**로 메뉴 자신에게 걸어야 한다)
 *   ⑤ 관제의 빨간 배지(지각 = 수동확정 필요)는 주 줄에 남는다
 *   ⑥ onclick 에는 고정 문자열·id 만(시트발 문자열 보간 금지 — 실측 XSS 선례)
 * 실행: node tests/campaignCardActions.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const cc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-cards.js'), 'utf8');

let n = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra ? ' :: ' + JSON.stringify(extra) : ''));
  n++; console.log('  ✓ ' + name);
};

/* ── ① 주 줄 = 3 + [⋯] ─────────────────────────────────────────── */
const act = /return `<div class="pact">([\s\S]*?)<\/div>`;/.exec(cc);
ok('액션 줄 템플릿을 찾는다', !!act);
const actHtml = act[1];

// 주 줄의 직접 버튼(<button class="uic"…) 개수 — viewBtn/pubToggle 은 변수 보간이라 따로 센다
const mainBtns = (actHtml.match(/<button type="button" class="uic/g) || []).length;
ok('★ 주 줄 직접 버튼 = 3개(수정·관제·⋯) + ${viewBtn} 보간 1 = 4개', mainBtns === 3 && /\$\{viewBtn\}/.test(actHtml), mainBtns);
ok('★ 주 줄에 시트·인원조절·리뷰어게이트 버튼이 없다(전부 [⋯] 안으로)',
  !/sheetBtn/.test(actHtml) && !/planBtn/.test(actHtml) && !/gateBtn/.test(actHtml));
ok('[⋯] 버튼이 주 줄 마지막(게시 토글 앞)', /class="uic more"[\s\S]*\$\{pubToggle\}/.test(actHtml));
/* ★ 130: 보관/보관 해제(arcBtn)가 메뉴에 합류했다 — 주 줄은 여전히 3개 + [⋯](위 단언이 고정).
   버튼이 더 늘어도 [⋯] 안으로 들어간다는 규율 그대로이므로 목록 패턴만 갱신한다(검사 의미 불변). */
ok('메뉴 항목은 인원조절·리뷰어게이트·보관만 모은다(시트 열기 제거)',
  /_ACT_MORE\[c\.id\] = \[planBtn, gateBtn, arcBtn\]\.filter\(Boolean\)\.join\(''\)/.test(cc)
  && !/sheetBtn/.test(cc));

// ⑤ 관제 배지는 주 줄에
ok('★ 관제 빨간 배지(지각)는 주 줄에 남는다(목록에서 바로 보여야 한다)',
  /class="uic ctrl"[\s\S]{0,160}\$\{bdg\}/.test(actHtml));

// 라벨은 .lbl 로 감싼다(넘침 측정·말줄임의 단일 지점)
ok('주 줄 라벨은 <span class="lbl"> 로 감싼다(수정·관제 + 보기 2변형)',
  (actHtml.match(/<span class="lbl">/g) || []).length === 2
  && (cc.match(/<span class="lbl">👁 보기<\/span>/g) || []).length === 2
  && /\.pcard \.uic \.lbl\{[^}]*text-overflow:ellipsis/.test(cc));
ok('[⋯] 는 고정 폭(글자 폭을 안 먹는다)', /\.pcard \.uic\.more\{[^}]*flex:0 0 auto[^}]*width:\d+px/.test(cc));

/* ── 메뉴 항목: 좁은 칸이 아니라 메뉴라 이름을 온전히 쓴다 ── */
ok('메뉴 항목은 인원조절·리뷰어 관리 2종만 표시한다',
  !/연결된 시트 열기/.test(cc) && /📅 날짜별 인원 조절/.test(cc) && /🚫 참여 리뷰어 관리/.test(cc));
ok('메뉴 항목 클래스는 .pcmi (주 줄 .uic 와 분리)',
  (cc.match(/class="pcmi"/g) || []).length >= 2 && /\.pcmenu \.pcmi\{/.test(cc));

/* ── ② body 직속 + 테마 무의존 ── */
ok('★ 메뉴는 body 직속으로 붙인다(.pcard overflow:hidden 에 안 잘리게)',
  /_menuEl = document\.createElement\('div'\)[\s\S]{0,200}document\.body\.appendChild\(_menuEl\)/.test(cc));
ok('.pcard 에 overflow:hidden 이 살아 있다(= body 직속이어야 하는 이유)',
  /\.pcard\{[^}]*overflow:hidden/.test(cc));
ok('메뉴 CSS 는 호스트 테마 변수에 기대지 않는다(리터럴 색)', (() => {
  const m = /\.pcmenu\{[\s\S]*?\.pcmenu \.pcmi:disabled\{[^}]*\}/.exec(cc);
  return !!m && !/var\(--/.test(m[0]);
})());

/* ── ⑥ onclick 위생 ── */
ok('★ [⋯] onclick 은 id 만 넘긴다(시트발 문자열 보간 금지)',
  /CampCards\._more\('\$\{id\}',this\)/.test(cc));

/* ── 목록 재렌더 시 열린 메뉴는 닫는다(가리키던 카드가 사라진다) ── */
ok('renderInto 가 _closeMenu 를 부른다', /_injectStyles\(\);\s*\n\s*_closeMenu\(\);/.test(cc));
ok('_more/_closeMenu 는 밖에서도 부를 수 있게 노출', /window\.CampCards = \{[^}]*_more, _closeMenu/.test(cc));

/* ── 런타임: 메뉴 기계장치를 vm 으로 꺼내 실제 실행 ───────────────────
   정적 검사는 "닫는 코드가 있나"까지만 본다 — 항목 클릭이 stopPropagation 으로
   document 리스너를 막는 것(실측 실패)은 **실행해야** 잡힌다. */
function slice(from, to, what) {
  const a = cc.indexOf(from);
  const requestedEnd = cc.indexOf(to, a + 1);
  const b = requestedEnd > a ? requestedEnd : cc.indexOf('  function cardHtml(', a + 1);
  assert(a >= 0 && b > a, '블록 추출 실패: ' + what);
  return cc.slice(a, b);
}
const menuSrc = slice('  var _ACT_MORE = Object.create(null);', '  /**\n   * 공고 카드.', '더보기 메뉴');

// 아주 작은 가짜 DOM — 캡처/버블 단계를 실제로 구분한다
function makeDom() {
  const listeners = { document: [], window: [] };
  function mkEl(cls) {
    const el = {
      className: cls || '', tagName: 'DIV', children: [], parent: null,
      style: {}, dataset: {}, disabled: false,
      offsetWidth: 200, offsetHeight: 120,
      _cap: [], _bub: [],
      set innerHTML(v) { this._html = v; this.children = (v.match(/class="pcmi"/g) || []).map(() => mkEl('pcmi')).map((c) => { c.parent = el; return c; }); },
      get innerHTML() { return this._html || ''; },
      addEventListener(t, fn, opt) { (opt === true || (opt && opt.capture) ? this._cap : this._bub).push({ t, fn }); },
      removeAttribute(a) { if (a === 'data-for') delete this.dataset.for; },
      getBoundingClientRect() { return { top: 400, bottom: 424, right: 300, left: 274 }; },
      closest(sel) {
        const want = sel.replace(/^\./, '');
        let cur = el;
        while (cur) { if ((cur.className || '').split(/[\s.]+/).includes(want)) return cur; cur = cur.parent; }
        return null;
      },
    };
    return el;
  }
  const body = mkEl('body');
  const doc = {
    body,
    createElement: mkEl,
    addEventListener(t, fn) { listeners.document.push({ t, fn }); },
  };
  body.contains = (el) => body.children.indexOf(el) >= 0;
  body.appendChild = (el) => { body.children.push(el); el.parent = body; return el; };
  const win = {
    innerWidth: 1400, innerHeight: 900,
    addEventListener(t, fn) { listeners.window.push({ t, fn }); },
  };
  // 클릭 디스패치: 캡처(조상→대상) → 대상 → 버블(대상→조상) + stopPropagation 재현
  function click(target, opts) {
    const stopped = { v: false };
    const ev = { target, type: 'click', stopPropagation() { stopped.v = true; } };
    const chain = [];
    for (let c = target; c; c = c.parent) chain.unshift(c);
    for (const el of chain) el._cap.forEach((l) => { if (l.t === 'click') l.fn(ev); });
    if (opts && opts.stop) stopped.v = true;                      // 항목 onclick 의 stopPropagation
    if (!stopped.v) for (const el of chain.slice().reverse()) el._bub.forEach((l) => { if (l.t === 'click') l.fn(ev); });
    if (!stopped.v) listeners.document.forEach((l) => { if (l.t === 'click') l.fn(ev); });
  }
  function key(k) { listeners.document.forEach((l) => { if (l.t === 'keydown') l.fn({ key: k }); }); }
  return { doc, win, listeners, click, key, body };
}

const dom = makeDom();
const timers = [];
const sandbox = {
  document: dom.doc, window: dom.win, Math,
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  console,
};
vm.createContext(sandbox);
vm.runInContext(menuSrc + '\n; this.__api = { _more: _more, _closeMenu: _closeMenu, _ACT_MORE: _ACT_MORE, _ensureMenu: _ensureMenu };', sandbox);
const api = sandbox.__api;
const flush = () => { while (timers.length) timers.shift()(); };

api._ACT_MORE['c1'] = '<button type="button" class="pcmi">a</button><button type="button" class="pcmi">b</button>';
api._ACT_MORE['c2'] = '<button type="button" class="pcmi">a</button>';
const btn1 = { className: 'uic more', parent: null, getBoundingClientRect: () => ({ top: 400, bottom: 424, right: 300, left: 274 }), closest(s) { return (s.indexOf('more') >= 0) ? this : null; } };

api._more('c1', btn1);
const menu = dom.body.children[0];
ok('실행: [⋯] 로 메뉴가 열린다', menu && menu.style.display === 'block' && menu.dataset.for === 'c1');
ok('실행: 메뉴는 body 직속 1개', dom.body.children.length === 1 && menu.className === 'pcmenu');
ok('실행: 기본은 버튼 위로 편다', parseInt(menu.style.top, 10) === 400 - menu.offsetHeight - 6, menu.style.top);
// ★ 위가 좁은 버튼(화면 상단)에서는 아래로 뒤집어야 한다 — 안 그러면 메뉴가 화면 밖으로 나간다
const btnTop = { className: 'uic more', parent: null, getBoundingClientRect: () => ({ top: 20, bottom: 44, right: 300, left: 274 }), closest(s) { return (s.indexOf('more') >= 0) ? this : null; } };
api._closeMenu(); api._more('c1', btnTop);
ok('★ 실행: 위가 좁으면 아래로 편다(화면 밖 금지)', (() => {
  const top = parseInt(menu.style.top, 10);
  return top >= 8 && top + menu.offsetHeight <= dom.win.innerHeight;
})(), menu.style.top);
api._closeMenu(); api._more('c1', btn1);

api._more('c1', btn1);
ok('실행: 같은 버튼 다시 = 닫힘(토글)', menu.style.display === 'none' && menu.dataset.for === undefined);

api._more('c2', btn1);
ok('실행: 다른 카드 = 그 카드 메뉴로 교체', menu.dataset.for === 'c2' && menu.style.display === 'block');

/* ④ 항목 클릭 — onclick 이 stopPropagation 을 해도 닫혀야 한다 */
api._more('c1', btn1);
dom.click(menu.children[0], { stop: true });
flush();
ok('★★ 실행: 항목을 고르면 닫힌다(항목이 stopPropagation 해도 — 실측 실패 재발 방지)',
  menu.style.display === 'none');

/* 바깥 클릭 / Esc */
api._more('c1', btn1);
dom.click({ className: 'somewhere', parent: null, _cap: [], _bub: [], closest: () => null });
ok('실행: 바깥 클릭 = 닫힘', menu.style.display === 'none');
api._more('c1', btn1);
dom.key('Escape');
ok('실행: Esc = 닫힘', menu.style.display === 'none');

/* ③ 리스너 1회만 — 메뉴 요소가 다시 만들어져도(호스트가 body 를 갈아엎는 화면) 겹치지 않아야 한다 */
const before = { d: dom.listeners.document.length, w: dom.listeners.window.length };
dom.body.children.length = 0;          // 메뉴 요소가 사라진 상황 재현 → _ensureMenu 가 다시 만든다
api._ensureMenu();
dom.body.children.length = 0;
api._ensureMenu(); api._more('c1', btn1); api._closeMenu();
ok('★ 리스너는 최상위에 한 번만(열 때마다 겹쳐 쌓이지 않는다)',
  dom.listeners.document.length === before.d && dom.listeners.window.length === before.w,
  { before, after: { d: dom.listeners.document.length, w: dom.listeners.window.length } });

/* 항목이 없으면 빈 메뉴를 띄우지 않는다 */
api._more('없는id', btn1);
ok('항목이 없으면 빈 메뉴를 열지 않는다', dom.body.children[dom.body.children.length - 1].style.display === 'none');

/* ═══════════════════════════════════════════════════════════════
   ④ ↗ 작업보드 바로가기 (사용자 확정 2026-08-19 — 게이지 줄 오른쪽)
      ★ 주 줄(3개 + [⋯])에는 넣지 않는다 — 폭이 다시 깨진다(위 ① 규율).
      ★ 관리자 카드 전용 · 작업표 없으면 비활성 + 사유 · 딥링크는 로그 탭과 같은 방식.
   ═══════════════════════════════════════════════════════════════ */
ok('④ ↗ 은 주 줄이 아니라 게이지 줄 안에 있다',
  /<span class="pg-rt">[\s\S]{0,200}\$\{wbBtn\}<\/span><\/div>/.test(cc)
  && !/class="pact"[\s\S]{0,400}pgwb/.test(cc));
ok('④ 관리자 게이지 두 갈래가 **같은 조각**을 쓴다(사본 0)',
  (cc.match(/\$\{wbBtn\}/g) || []).length === 2
  && /const wbBtn = _worktableBtn\(c\);/.test(cc)
  && (cc.match(/const wbBtn = _worktableBtn\(c\);/g) || []).length === 1);
ok('④ 관리자 분기 안에서만 만든다(리뷰어 카드에는 안 그린다)',
  /if \(admin\) \{\s*\n\s*\/\/[^\n]*\n\s*const wbBtn = _worktableBtn\(c\);/.test(cc));
ok('④ 작업표 없음·비로그인은 비활성 + 사유(죽은 버튼 금지)',
  /class="pgwb" disabled title="이 공고에 연결된 작업표가 아직 없습니다/.test(cc)
  && /class="pgwb" disabled title="작업보드는 관리자 로그인이 필요합니다/.test(cc));
ok('④ onclick 에는 공고 id 만(시트발 탭명은 title 속성에만 — XSS 규율)',
  /CampCards\.openWorkdesk\('\$\{_esc\(c\.id\)\}'\)/.test(cc)
  && !/openWorkdesk\('\$\{_esc\(c\.linked_tab_name\)/.test(cc)
  && /title="작업보드를 새 탭으로 열기 — \$\{_esc\(c\.linked_tab_name\)\}"/.test(cc));
/* ★★ 미리 여는 창에 noopener 를 쓰면 핸들이 null 이라 **빈 탭 + 진짜 탭 두 개**가 열린다(실측).
   대신 주소를 넣은 직후 opener 를 끊는다 — 같은 보호, 탭은 하나. */
ok('④ 팝업 차단 회피: window.open 은 await 앞 · noopener 대신 opener 끊기',
  /let w = null;\s*\n\s*try \{ w = window\.open\(''\, '_blank'\); \}/.test(cc)
  && /try \{ w\.opener = null; \} catch/.test(cc)
  && cc.indexOf("w = window.open(''") < cc.indexOf('await _ensureCampCtx'));
ok('④ 딥링크는 리뷰어 로그와 같은 방식(#go= + &sso=) — 서버 변경 0',
  /'#go=' \+ encodeURIComponent\(JSON\.stringify\(payload\)\) \+ '&sso=' \+ encodeURIComponent\(tok\)/.test(cc)
  && /new URL\('workdesk\.html', location\.href\)/.test(cc));
ok('④ 연결 탭 문맥 조회는 수동제출과 같은 헬퍼(사본 0)',
  (cc.match(/await _ensureCampCtx\(id, tok\)/g) || []).length === 2);
ok('④ CampCards 로 노출(onclick 이 부를 수 있어야 한다)', /openManualOrder, openWorkdesk,/.test(cc));
/* ★ 이 CSS 블록은 템플릿 리터럴 안이다 — 주석의 백틱 하나가 CSS 를 끊고 뒤를 JS 로 파싱시킨다
   (실측: ReferenceError: row is not defined). 스타일 문자열에 백틱이 없어야 한다. */
{
  const m = /st\.textContent = `([\s\S]*?)`;/.exec(cc);
  ok('④ 스타일 템플릿이 통째로 살아 있다(주석 백틱으로 끊기지 않음)',
    !!m && /\.pcard \.pgwb\{/.test(m[1]) && /\.pcard \.pg-rt\{/.test(m[1]));
}

console.log(`\n✅ campaignCardActions: ${n}개 통과`);
