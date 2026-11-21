// 결정 391 — 1:1 문의 대화창: 휴대폰 키보드가 올라오면 창을 「지금 보이는 영역」에 맞춘다.
// 종전: 아래에 붙은 84vh 창이 입력칸을 보이려고 위로 밀려 머리(제목·뒤로·닫기)가 화면 밖으로 사라졌다
// (아이폰 사파리·안드로이드 크롬 실기 공통 · 2026-11-20).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'js', 'reviewer-cs.js'), 'utf8');
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

function run(vv, display) {
  const sheet = { style: {} };
  const ov = { style: { display }, firstElementChild: sheet };
  const ctx = { window: { visualViewport: vv }, document: { getElementById: (id) => (id === 'rcsOverlay' ? ov : null) }, Math };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(SRC, 'fitToVisible') + '\nthis.f=fitToVisible;', ctx);
  ctx.f();
  return { ov: ov.style, sheet: sheet.style };
}

test('키보드가 떠 있으면 덮개를 보이는 영역 위치·높이로 옮기고 창 높이를 그 안으로', () => {
  const r = run({ offsetTop: 303.4, height: 411.2 }, 'flex');
  assert.strictEqual(r.ov.top, '303px');
  assert.strictEqual(r.ov.height, '411px');
  assert.strictEqual(r.ov.bottom, 'auto');
  assert.strictEqual(r.sheet.maxHeight, '411px', '창(84vh)이 보이는 높이를 넘으면 머리가 위로 밀린다');
});

test('키보드가 없으면 화면 전체 = 종전 모양과 같다 · 닫힌 창·visualViewport 없는 브라우저는 건드리지 않는다', () => {
  const full = run({ offsetTop: 0, height: 714 }, 'flex');
  assert.deepStrictEqual([full.ov.top, full.ov.height], ['0px', '714px']);
  assert.strictEqual(run({ offsetTop: 303, height: 411 }, 'none').ov.top, undefined, '닫힌 덮개는 그대로');
  assert.strictEqual(run(undefined, 'flex').ov.top, undefined, 'visualViewport 가 없으면 종전(inset:0) 그대로');
});

test('배선 — 크기·위치가 바뀔 때마다 · 창을 그린 직후에도 맞춘다', () => {
  assert.match(SRC, /visualViewport\.addEventListener\("resize", fitToVisible\)/);
  assert.match(SRC, /visualViewport\.addEventListener\("scroll", fitToVisible\)/);
  const open = fnSrc(SRC, 'openChat');
  assert.ok(open.indexOf('fitToVisible();') > open.indexOf('ov.innerHTML = `<div style="${SHEET}">'), '창 내용을 그린 뒤 다시 맞춰야 창 높이 제한이 걸린다');
  assert.match(IX, /js\/reviewer-cs\.js\?v=20261120-kbfit/, '캐시 버전을 올려야 옛 파일이 남지 않는다');
});
