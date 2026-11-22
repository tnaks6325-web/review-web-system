// 결정 393 — 리뷰어 홈 아래에서 올라오는 창(.ovl: 수정요청·참여상품 정보·안내)도 휴대폰 키보드가 뜨면 보이는 영역에 맞춘다.
// 종전: 수정요청 사유 칸을 누르면 창 머리(제목·닫기)가 화면 위로 밀려 사라졌다(아이폰 사파리 실기 −90px). 문의 대화창(결정 391)과 같은 방법.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const IX = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');

function fnSrc(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, name + ' 함수가 없다');
  let depth = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced');
}

function run(vv, innerHeight, pre) {
  const mk = () => ({ style: Object.assign({}, pre || {}), firstElementChild: { style: Object.assign({}, pre ? { maxHeight: '300px' } : {}) } });
  const ovls = [mk(), mk(), mk()];
  const ctx = { window: { visualViewport: vv, innerHeight }, document: { querySelectorAll: (q) => (q === '.ovl' ? ovls : []) }, Math };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(IX, '_rhFitOvlToVisible') + '\nthis.f=_rhFitOvlToVisible;', ctx);
  ctx.f();
  return ovls;
}

test('키보드가 떠 있으면 모든 .ovl 을 보이는 영역에 · 창 높이는 보이는 높이와 88vh 중 작은 쪽', () => {
  const o = run({ offsetTop: 303.2, height: 411.4 }, 714);
  for (const x of o) {
    assert.deepStrictEqual([x.style.top, x.style.bottom, x.style.height], ['303px', 'auto', '411px']);
    assert.strictEqual(x.firstElementChild.style.maxHeight, '411px');
  }
  const android = run({ offsetTop: 0, height: 471 }, 783);   // 안드로이드: 위치는 그대로, 높이만 준다
  assert.deepStrictEqual([android[0].style.top, android[0].style.height, android[0].firstElementChild.style.maxHeight], ['0px', '471px', '471px']);
});

test('키보드가 없으면 넣어 둔 값을 지워 CSS 종전 모양으로 · visualViewport 없으면 무동작', () => {
  const o = run({ offsetTop: 0, height: 714 }, 714, { top: '303px', bottom: 'auto', height: '411px' });
  for (const x of o) {
    assert.deepStrictEqual([x.style.top, x.style.bottom, x.style.height, x.firstElementChild.style.maxHeight], ['', '', '', '']);
  }
  const none = run(undefined, 714);
  assert.strictEqual(none[0].style.top, undefined);
});

test('배선 — 보이는 영역이 바뀔 때마다 · 수정요청·참여상품 정보 창을 열 때 맞춘다', () => {
  assert.match(IX, /visualViewport\.addEventListener\('resize', _rhFitOvlToVisible\)/);
  assert.match(IX, /visualViewport\.addEventListener\('scroll', _rhFitOvlToVisible\)/);
  assert.match(fnSrc(IX, 'openReviewEditModal'), /_reEditEnsureOverlay\(\);\n\s*_rhFitOvlToVisible\(\);/);
  assert.match(fnSrc(IX, 'openPartInfoSheet'), /_partInfoEnsure\(\);\n\s*_rhFitOvlToVisible\(\);/);
});
