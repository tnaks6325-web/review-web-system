/**
 * foundDuringE2E.test.js — 순차진행 E2E(2026-10-08) 중 발견한 무관 결함 2건 회귀가드
 * 실행: node tests/foundDuringE2E.test.js
 *
 *  ① 관리자 화면 _applyHiddenCols: 빈 스텁 버튼(#btnColVis)에서 예외 → 대시보드 렌더 뒤 단계가 건너뛰어짐
 *  ② 구매양식 제출의 구매일자가 비면 작업표에 미리 적힌 구매일자를 지움 → 서버가 오늘(KST)을 채운다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }
const fnSrc = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no ' + name);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unclosed ' + name);
};

console.log('\n[1] 관리자 화면 열 설정 버튼 — 빈 스텁에서도 예외 없이');
const app = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-app.js'), 'utf8');
const mkBtn = (children) => {
  const btn = {
    childNodes: children, classList: { toggle() {} },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    querySelector(sel) { return sel === 'i' ? (this.childNodes.find(c => c.tag === 'i') || null) : null; },
    appendChild(n) { this.childNodes.push(n); return n; },
  };
  return btn;
};
const run = (btn, hiddenActive) => {
  const sb = {
    document: {
      body: { classList: { _s: [], [Symbol.iterator]() { return [][Symbol.iterator](); }, remove() {}, add() {} } },
      getElementById: id => (id === 'btnColVis' ? btn : null),
      createTextNode: t => ({ nodeType: 3, textContent: t }),
    },
    _colsHiddenActive: hiddenActive, _selectedHideCols: new Set(['a']),
    _refreshDropdownToggleBtn() {},
  };
  sb.document.body.classList = Object.assign([], { remove() {}, add() {} });
  vm.createContext(sb);
  vm.runInContext(fnSrc(app, '_applyHiddenCols') + ';_applyHiddenCols();', sb);
};
let b = mkBtn([]);
let threw = false;
try { run(b, false); } catch (e) { threw = e; }
ok('빈 스텁 버튼(자식 0): 예외 없음', !threw);
ok('빈 스텁 버튼: 글자 칸을 만들어 " 열 설정" 기록', b.childNodes.length === 1 && b.childNodes[0].textContent === ' 열 설정');
b = mkBtn([{ tag: 'i', nodeType: 1, className: 'fas fa-columns' }, { nodeType: 3, textContent: ' 열 설정' }]);
run(b, true);
ok('정상 버튼(아이콘+글자): 글자만 바뀜 — 자식 수 그대로', b.childNodes.length === 2 && b.childNodes[1].textContent === ' 열 숨김 중' && b.childNodes[0].className === 'fas fa-eye-slash');
ok('종전 예외 코드(마지막 자식 무조건 접근) 제거', !/btn\.childNodes\[btn\.childNodes\.length - 1\]\.textContent/.test(app));

console.log('\n[2] 구매양식 제출 — 구매일자가 비면 오늘(KST)');
const sub = fs.readFileSync(path.join(__dirname, '../src/routes/submit.routes.js'), 'utf8');
ok('구매일자 = 항상 서버 오늘(KST) · 관리자 수기 주문과 같은 함수(결정 215 → 248 강화)', /const effectiveDateStr = require\('\.\.\/services\/manualOrder\.service'\)\.todayKstDateStr\(\);/.test(sub));
ok('★ 248: 화면이 보낸 구매일자로 정하지 않는다(휴대폰 시계가 늦으면 자정 직후가 전날로 적힌다)', !/const effectiveDateStr = String\(dateStr/.test(sub) && !/effectiveDateStr = [^;]*_clientDateStr/.test(sub));
ok('★ 248: 화면 날짜와 다르면 로그만 남긴다', /_clientDateStr[\s\S]{0,200}!== effectiveDateStr[\s\S]{0,40}logger\.warn/.test(sub));
ok('orderData 는 채운 값을 쓴다(빈 dateStr 를 그대로 넘기지 않음)', /const orderData = \{[^}]*dateStr: effectiveDateStr,/.test(sub) && !/const orderData = \{[^}]*depositor, price, dateStr, orderNum/.test(sub));
const { todayKstDateStr } = require('../src/services/manualOrder.service');
ok('채우는 형식 = 리뷰어 화면과 같은 "M / D (요일)"', todayKstDateStr(new Date('2026-10-08T05:00:00Z')) === '10 / 8 (목)');
ok('★ 248 실측 재현: KST 10/14 0시 14분(UTC 10/13 15:14) 제출 = 10/14', todayKstDateStr(new Date('2026-10-13T15:14:43Z')) === '10 / 14 (수)');
const wd = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
ok('리뷰어 화면이 보내는 형식도 같다(드리프트 감시)', /const dateStr = `\$\{now\.getMonth\(\)\+1\} \/ \$\{now\.getDate\(\)\} \(\$\{days\[now\.getDay\(\)\]\}\)`/.test(wd));

console.log(`\n✅ foundDuringE2E — ${passed} passed`);
