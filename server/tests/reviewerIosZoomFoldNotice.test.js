// 결정 388 — 실기(아이폰 사파리·안드로이드 크롬) 점검에서 나온 두 가지 (2026-11-20)
//
// ① 구매양식 직접 링크(search.html?s=..)의 입력칸(14px)을 아이폰에서 누르면 화면이 확대되고, 키보드를 닫아도 그대로 남아
//    왼쪽 항목 이름이 잘렸다(iPhone 17 / iOS 27.2 실기). 아이폰에서만 viewport 에 maximum-scale=1 을 붙인다.
// ② 본계정으로 합친 타계정을 다시 저장하면 서버는 저장하지 않고 foldedSkipped·message 를 주는데
//    화면은 「추가되었습니다」만 띄웠다(결정 226 의 미뤄 둔 화면 표시).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.resolve(__dirname, '..', '..', 'frontend');
const IX = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
const SH = fs.readFileSync(path.join(FRONT, 'search.html'), 'utf8');
const APP = fs.readFileSync(path.join(FRONT, 'js', 'search-app.js'), 'utf8');

function fnSrc(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, name + ' 함수를 찾지 못했다');
  let depth = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

// search.html 의 viewport 보정 스크립트를 가짜 문서에서 그대로 실행한다.
function runViewportFix(ua, touch) {
  const block = /<meta name="viewport"[^>]*>\s*<script>([\s\S]*?)<\/script>/.exec(SH);
  assert.ok(block, 'viewport meta 바로 뒤에 보정 스크립트가 있어야 한다(본문 스크립트보다 먼저 돌아야 첫 입력부터 막힌다)');
  let content = /<meta name="viewport" content="([^"]*)"/.exec(SH)[1];
  const meta = { getAttribute: () => content, setAttribute: (k, v) => { if (k === 'content') content = v; } };
  Object.defineProperty(meta, 'content', { get: () => content, set: (v) => { content = v; } });
  const ctx = { navigator: { userAgent: ua, maxTouchPoints: touch || 0 }, document: { querySelector: (q) => (/viewport/.test(q) ? meta : null) } };
  vm.createContext(ctx);
  vm.runInContext(block[1], ctx);
  return content;
}

test('① 아이폰 사파리에서만 maximum-scale=1 — 누를 때 자동 확대 막기', () => {
  const base = 'width=device-width, initial-scale=1.0';
  assert.strictEqual(/<meta name="viewport" content="([^"]*)"/.exec(SH)[1], base, '기본 viewport 는 그대로(안드로이드 손가락 확대 유지)');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1';
  assert.strictEqual(runViewportFix(iphone), base + ', maximum-scale=1.0', '아이폰');
  assert.strictEqual(runViewportFix('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5), base + ', maximum-scale=1.0', '아이패드(데스크톱 표기 + 터치)');
  assert.strictEqual(runViewportFix('Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36'), base, '안드로이드는 그대로');
  assert.strictEqual(runViewportFix('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0), base, 'PC 맥 사파리는 그대로');
  assert.doesNotMatch(SH, /user-scalable=no/, '손가락 확대까지 막지 않는다');
});

test('② 리뷰어 홈 타계정 저장 — foldedSkipped 면 서버 문구를 보여 준다', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fnSrc(IX, '_subSaveToast') + '\nthis.f=_subSaveToast;', ctx);
  const why = '본계정과 같은 번호의 타계정은 본계정으로 합쳐져 있어 다시 저장하지 않았어요.';
  assert.strictEqual(ctx.f({ ok: true }, '✅ 타계정이 추가되었습니다', false), '✅ 타계정이 추가되었습니다', '평소엔 종전 문구 그대로');
  assert.strictEqual(ctx.f({ ok: true, foldedSkipped: 1, message: why }, '✅ 타계정이 추가되었습니다', false), 'ℹ️ ' + why, '추가가 안 됐는데 「추가되었습니다」라고 하면 안 된다');
  assert.strictEqual(ctx.f({ ok: true, foldedSkipped: 1, message: why }, '✅ 타계정이 수정되었습니다', true), '✅ 타계정이 수정되었습니다 · ' + why);
  assert.strictEqual(ctx.f({ ok: true, foldedSkipped: 1 }, '✅ 타계정이 추가되었습니다', false), 'ℹ️ ' + why, '문구 없는 응답에도 같은 말');
  assert.match(fnSrc(IX, 'confirmSaveInlineSubAccount'), /showToast\(_subSaveToast\(res, /, '저장 성공 안내가 이 함수를 거쳐야 한다');
});

test('② 리뷰 제출 화면(search) 타계정 추가·수정도 같은 안내', () => {
  assert.strictEqual(APP.indexOf('showToast(editIdx >= 0 ? "타계정이 수정되었습니다." : "타계정이 추가되었습니다.")'), -1,
    '합쳐짐을 무시하고 「추가되었습니다」만 띄우는 옛 줄이 남아 있다');
  assert.match(APP, /const _folded = Number\(res\.foldedSkipped\) > 0;/);
  assert.match(APP, /\(editIdx >= 0 \? "타계정이 수정되었습니다\. " \+ _why : _why\)/);
});
