/**
 * 주문자 = 로그인한 리뷰어 이름 (사용자 확정 2026-08-24 · "가" 안)
 *
 * 구매양식에서 [주문자]를 한 번 더 치게 하지 않고 서버가 로그인 이름으로 채운다.
 * 리뷰웹시스템[3버전]에서는 **작업보드의 참여자 칸이 주문자 자리를 대체**하기 때문이다
 * (`sheetlessOrder` 가 참여자 이름을 `loginName || orderer || recipient` 로 정한다).
 *
 * ★ 이 가드가 지키는 것 — 완화하면 아래가 그대로 깨진다:
 *   ① 서버 필수 검증이 채운 값을 봐야 한다(안 그러면 전 제출이 FIELDS_REQUIRED 로 막힌다)
 *   ② **값이 오면 그 값이 이긴다** — 인애드명단에서 고른 이름(행 배정 근거)·타계정 다건의
 *      명의 프리필을 로그인 이름으로 덮으면 안 된다
 *   ③ 로그인 이름이 없으면 채우지 않는다(레거시·관리자 경유 = 종전대로 필수, fail-closed)
 *   ④ 화면은 요소를 **지우지 않고 감춘다**(of_orderer 를 참조하는 코드가 6곳)
 *   ⑤ 노출 판정은 함수 하나 — 화면과 검증이 갈리면 "안 보이는데 필수"가 된다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const submit = R('server/src/routes/submit.routes.js');
const app = R('frontend/js/search-app.js');
const css = R('frontend/css/search.css');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 1. 서버: 채움 규칙 ───────────────────────────────────────────── */
const decl = /const _orderer = String\(orderer \|\| ''\)\.trim\(\) \|\| String\(loginName \|\| ''\)\.trim\(\);/.exec(submit);
ok('★ 주문자는 `orderer || loginName` 으로 채운다(빈 값일 때만 로그인 이름)', !!decl);

ok('★★ 값이 오면 그 값이 이긴다 — orderer 가 왼쪽(명단 선택·타계정 명의 프리필 보존)',
  !!decl && decl[0].indexOf('orderer ||') < decl[0].indexOf('loginName'));

ok('★ 로그인 이름이 없으면 채우지 않는다 — 레거시·관리자 경유는 종전대로 필수(fail-closed)',
  /String\(loginName \|\| ''\)\.trim\(\)/.test(submit));

ok('필수 검증이 채운 값을 본다(안 보면 전 제출이 FIELDS_REQUIRED 로 막힌다)',
  /\[_orderer, '주문자'\]/.test(submit) && !/\[orderer, '주문자'\]/.test(submit));

ok('주문 원장(orderData)에도 채운 값이 실린다',
  /const orderData = \{ orderer: _orderer,/.test(submit));

ok('SSE 알림도 같은 값을 쓴다(화면마다 다른 주문자가 뜨지 않는다)',
  /orderer: _orderer \|\| '',/.test(submit));

ok('★ 소비처가 전부 _orderer 를 쓴다 — 한 곳만 쓰면 "검증은 통과인데 원장은 빈 주문자"',
  (submit.match(/_orderer/g) || []).length >= 4);

/* ── 2. 화면: 요소는 남기고 감춘다 ───────────────────────────────── */
ok('★★ `of_orderer` 입력 요소는 그대로 있다(지우면 참조 6곳이 null 을 만난다)',
  /id="of_orderer"/.test(app));

ok('감추는 클래스가 주문자 묶음에 붙는다',
  /id="\$\{cid\}_ordererWrap" class="ofc-orderer-wrap /.test(app));

ok('CSS 기본은 감춤이고 `.of-orderer-on` 일 때만 보인다',
  /\.ofc-orderer-wrap\{display:none\}/.test(css)
  && /\.of-orderer-on \.ofc-orderer-wrap\{display:block\}/.test(css));

ok('★ 조용한 자동 채움 금지 — 화면이 "본인 이름으로 자동 기록"을 말한다',
  /ofc-orderer-note/.test(app) && /자동 기록됩니다/.test(app));

ok('공유 체크 라벨이 감춰진 주문자를 말하지 않는다(감출 때 같이 접힌다)',
  /<span class="ofc-same-orderer">주문자 \/ <\/span>/.test(app)
  && /\.of-orderer-on \.ofc-same-orderer\{display:inline\}/.test(css));

/* ── 3. 판정 단일 출처 ───────────────────────────────────────────── */
ok('★★ 노출 판정은 `_ordererPickerOn()` 하나 — 검증 두 곳이 그것을 쓴다',
  /if \(_ordererPickerOn\(\) && !firstOrderer\)/.test(app)
  && /if \(_ordererPickerOn\(\) && !gv\(cid \+ "_orderer"\)\)/.test(app));

ok('인애드명단 로드 세 갈래(성공·빈값·실패) 모두에서 노출을 다시 판정한다',
  (app.match(/_applyOrdererPicker\(\);/g) || []).length >= 3);

/* ── 4. 무회귀 ───────────────────────────────────────────────────── */
ok('★ 타계정 다건 프리필은 그대로 — 카드마다 그 명의 이름이 주문자로 남는다',
  /set\("_recipient", h\.name\); set\("_orderer", h\.name\);/.test(app));

ok('★ 인애드명단 자동완성 흐름(명단에서 고르기 → 옵션 표시)은 무변경',
  /function selectAcItem/.test(app) && /function onOrdererInput/.test(app)
  && /function _setOrdererDisabled/.test(app));

ok('★ 배치(타계정 다건)는 본인 이름 안내를 감춘다 — 그 카드는 명의 이름이 주문자로 간다',
  /classList\.add\("of-orderer-batch"\)/.test(app)
  && /\.of-orderer-batch \.ofc-orderer-note\{display:none\}/.test(css));

ok('★★ 카드 마크업 주석에 백틱이 없다 — 템플릿 리터럴이 그 자리에서 끊긴다(실측 사고)',
  (() => {
    const i = app.indexOf('function _buildOrderCardHtml(');
    const j = app.indexOf('function _buildCoupangCardHtml(');
    const body = app.slice(i, j > i ? j : i + 20000);
    // 주석 줄(<!-- ... -->)에 백틱이 섞이면 런타임에 ReferenceError 가 난다
    return !body.split('\n').some(l => /<!--|-->/.test(l) && l.includes('`'));
  })());

/* ── 5. 실행 — 후보 유무에 따라 실제로 갈리는가 ──────────────────── */
(() => {
  const grab = (name) => {
    const i = app.indexOf('function ' + name + '(');
    assert.ok(i > 0, name + ' 를 찾지 못했다');
    let d = 0, started = false;
    for (let j = i; j < app.length; j++) {
      if (app[j] === '{') { d++; started = true; }
      else if (app[j] === '}') { d--; if (started && d === 0) return app.slice(i, j + 1); }
    }
    throw new Error(name + ' 본문 추출 실패');
  };

  const cls = new Set();
  const wrapEl = {
    classList: {
      contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
    },
  };
  const sandbox = {
    _inaedNames: [],
    document: { getElementById: (id) => (id === 'ofOrderCardsWrap' ? wrapEl : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(grab('_ordererPickerOn') + '\n' + grab('_applyOrdererPicker'), sandbox);

  sandbox._inaedNames = [];
  sandbox._applyOrdererPicker();
  ok('실행: 인애드명단 후보 0건 → 주문자 칸 감춤(서버가 로그인 이름으로 채운다)',
    sandbox._ordererPickerOn() === false);

  sandbox._inaedNames = [{ name: '홍길동' }];
  sandbox._applyOrdererPicker();
  ok('실행: 후보가 있으면 도로 보여준다(그 탭은 명단 선택이 행 배정 근거)',
    sandbox._ordererPickerOn() === true);

  sandbox._inaedNames = [];
  sandbox._applyOrdererPicker();
  ok('실행: 탭을 옮겨 후보가 사라지면 다시 감춘다(상태가 남지 않는다)',
    sandbox._ordererPickerOn() === false);

  // 화면이 없는 호스트에서도 죽지 않는다(임베드·미리보기)
  const s2 = { _inaedNames: [{ name: 'x' }], document: { getElementById: () => null } };
  vm.createContext(s2);
  vm.runInContext(grab('_ordererPickerOn') + '\n' + grab('_applyOrdererPicker'), s2);
  s2._applyOrdererPicker();
  ok('실행: 카드 영역이 없는 화면에서도 예외 없이 false',
    s2._ordererPickerOn() === false);
})();

console.log(`\n✅ ordererAutoFill: ${n}개 통과`);
process.exit(0);
