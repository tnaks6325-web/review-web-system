/**
 * 전화번호 화면 표기 통일 — `010-0000-0000` (사용자 확정 2026-09-30)
 *
 * ★ 표시 전용이다. 저장값은 바꾸지 않는다(로그인·중복 확인·신원 연결이 숫자만 있는 원본으로 비교).
 * ★ 규칙은 두 벌(api.js `fmtPhone` · workdesk.html `_fmtPhone`)이 글자 그대로 같아야 한다 — 같은 입력으로 실행해 대조.
 * ★ 글자·마스킹(*)이 섞인 값은 원본 유지(숫자만 남기면 글자가 사라진다).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FE = p => path.join(__dirname, '..', '..', 'frontend', p);
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

function extract(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' 없음');
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

const apiSrc = fs.readFileSync(FE('api.js'), 'utf8');
const wdSrc = fs.readFileSync(FE('workdesk.html'), 'utf8');
const box = {};
vm.runInNewContext(extract(apiSrc, 'fmtPhone') + '\n' + extract(wdSrc, '_fmtPhone') + '\nthis.a=fmtPhone;this.b=_fmtPhone;', box);

const CASES = [
  ['01077379704', '010-7737-9704'],
  ['010-4117-6760', '010-4117-6760'],
  ['010 4117 6760', '010-4117-6760'],
  ['1077379704', '010-7737-9704'],          // 앞자리 0 소실 보정
  ['67671416', '010-6767-1416'],            // phone8
  ['010-448-0931', '010-448-0931'],
  ['0212345678', '02-1234-5678'],
  ['021234567', '02-123-4567'],
  ['010-5523-0909, 0502-2880-0621', '010-5523-0909, 0502-2880-0621'],   // 번호 두 개 = 원본
  ['010-2869-8501(0504-3286-6328)', '010-2869-8501(0504-3286-6328)'],
  ['010-****-1234', '010-****-1234'],       // 마스킹 = 원본
  ['홍길동 01012345678', '홍길동 01012345678'], // 글자 섞임 = 원본
  ['없음', '없음'], ['', ''], [null, ''], [undefined, ''],
];

console.log('\n§1 표기 규칙');
for (const [inp, want] of CASES) {
  t(`fmtPhone(${JSON.stringify(inp)}) = ${JSON.stringify(want)}`, () => assert.strictEqual(box.a(inp), want));
}

console.log('\n§2 두 벌이 같게 동작한다');
t('api.js fmtPhone ≡ workdesk _fmtPhone (전 케이스)', () => {
  for (const [inp] of CASES) assert.strictEqual(box.a(inp), box.b(inp), JSON.stringify(inp));
});

console.log('\n§3 화면 배선 — 번호를 가공 없이 찍지 않는다');
const WIRED = {
  'workdesk.html': [
    /<td class="mono">\$\{esc\(_fmtPhone\(c\.phone\|\|''\)\)\}<\/td>/,          // 명의 정리 표(신고 화면)
    /<td class="c-ph">\$\{dash\(_fmtPhone\(r\.phone\)\)\}/,                        // 등록리뷰어DB 본계정
    /\$\{dash\(_fmtPhone\(s\.phone\)\)\}/,                                          // 등록리뷰어DB 타계정
  ],
  'js/cs-inquiry.js': [/fmtPhone\(r\.reviewerPhone8/, /kv\('연락처', \(typeof fmtPhone/],
  'js/index-app.js': [/escHtml\(\(typeof fmtPhone==='function'\?fmtPhone\(r\.phone\)/, /sPhoneFmt = \(typeof fmtPhone/],
  'js/search-app.js': [/rcPhone"\)\.textContent = \(typeof fmtPhone/, /rpmSelfPhone"\)\.textContent\s+= \(typeof fmtPhone/],
  'index.html': [/pf-ph">\$\{escHtml\(\(typeof fmtPhone/],
};
for (const [f, pats] of Object.entries(WIRED)) {
  const src = fs.readFileSync(FE(f), 'utf8');
  pats.forEach((re, k) => t(`${f} #${k + 1}`, () => assert.ok(re.test(src), re.toString())));
}
t('workdesk 등록리뷰어DB 구간에 가공 없는 phone 출력이 남지 않는다', () => {
  const raw = (wdSrc.match(/\$\{(?:esc|dash)\((?:[a-z]+\.)?phone(?:\|\|'')?\)\}/g) || []);
  assert.deepStrictEqual(raw, []);
});

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
