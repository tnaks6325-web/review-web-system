'use strict';
/**
 * 회귀가드 — 통합 작업대 [업무가이드] 메뉴
 *
 * 실행: node tests/workGuides.test.js
 *
 * ★ 이 가드가 지키는 것:
 *   ① 목록에 적힌 안내서 파일이 **실제로 존재**한다(문서를 지우거나 이름을 바꾸면 죽은 링크)
 *   ② 광고주에게는 메뉴가 없다(내부 업무 문서)
 *   ③ 목록은 한 곳(WORK_GUIDES)에서만 관리한다(사본 금지)
 *   ④ 인라인 스크립트가 파싱된다 — 주석 안 `*` + `/` 조합이 블록 주석을 조기 종료시켜
 *      화면 전체가 죽는 사고가 개발 중 실제로 났다(CSS `:root` 삼킴 사고와 같은 계열).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend');
const wd = fs.readFileSync(path.join(FRONT, 'workdesk.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

/** workdesk.html 의 인라인 스크립트 블록들(외부 src 제외) */
function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const out = []; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

console.log('\n[1] 인라인 스크립트 무결성');

t('★ 모든 인라인 스크립트 블록이 파싱된다(블록 주석 조기 종료 차단)', () => {
  inlineScripts(wd).forEach((src, i) => {
    try { new vm.Script(src, { filename: `workdesk-block-${i + 1}.js` }); }
    catch (e) { throw new Error(`블록 #${i + 1} 파싱 실패: ${e.message}`); }
  });
});

t('★ 주석 안에 블록 주석을 닫는 조합이 없다(*/ 를 설명문에 쓰지 말 것)', () => {
  // 블록 주석을 하나씩 떼어 내부에 또 다른 종료 토큰이 없는지 본다
  for (const src of inlineScripts(wd)) {
    const re = /\/\*([\s\S]*?)\*\//g; let m;
    while ((m = re.exec(src))) {
      assert.ok(!m[1].includes('*/'), '블록 주석 안에 */ 가 또 있다');
    }
  }
});

console.log('\n[2] 업무가이드 목록');

const guideBlock = wd.match(/const WORK_GUIDES = \[([\s\S]*?)\n\];/);

t('WORK_GUIDES 목록이 있다', () => {
  assert.ok(guideBlock, 'WORK_GUIDES 배열을 찾지 못했다');
});

t('★ 목록은 한 곳에만 있다(사본 금지)', () => {
  const n = (wd.match(/const WORK_GUIDES\s*=/g) || []).length;
  assert.strictEqual(n, 1, `WORK_GUIDES 선언이 ${n}개 — 사본을 두면 화면마다 목록이 갈라진다`);
});

const files = [...wd.matchAll(/file:\s*'([^']+\.html)'/g)].map(m => m[1]);

t('★ 목록에 적힌 안내서가 전부 실제로 존재한다(죽은 링크 차단)', () => {
  assert.ok(files.length >= 5, `가이드가 ${files.length}개뿐 — 목록을 못 읽은 것 같다`);
  const missing = files.filter(f => !fs.existsSync(path.join(FRONT, 'docs', f)));
  assert.deepStrictEqual(missing, [], '없는 문서를 가리키고 있다: ' + missing.join(', '));
});

t('★ 내부 설계문서(prd-/design- 접두)는 목록에 넣지 않는다', () => {
  // 예외: prd-userflow.html 은 "시스템 소개서"로 관리자 화면에서도 쓰는 공식 안내서다
  const ALLOW = new Set(['prd-userflow.html']);
  const bad = files.filter(f => /^(prd|design)-/.test(f) && !ALLOW.has(f));
  assert.deepStrictEqual(bad, [], '직원 대상이 아닌 설계 초안이 섞였다: ' + bad.join(', '));
});

t('항목마다 제목·설명·분류가 채워져 있다', () => {
  const items = guideBlock[1].split(/\},\s*\n/).filter(x => x.includes('file:'));
  assert.strictEqual(items.length, files.length, '항목 수와 파일 수가 다르다');
  for (const it of items) {
    for (const key of ['cat:', 'title:', 'desc:', 'icon:']) {
      assert.ok(it.includes(key), `${key} 가 빠진 항목이 있다: ${it.slice(0, 60)}`);
    }
  }
});

t('링크는 새 창 + noopener 로 연다', () => {
  const a = wd.match(/class="gdcard"[^`]*/);
  assert.ok(a, 'gdcard 링크를 찾지 못했다');
  assert.ok(/target="_blank"/.test(a[0]), '새 창으로 열지 않는다');
  assert.ok(/rel="noopener"/.test(a[0]), 'noopener 가 없다');
  assert.ok(/encodeURIComponent\(g\.file\)/.test(wd), '한글 파일명이 인코딩되지 않는다');
});

console.log('\n[3] 메뉴 노출 권한');

t('관리자·AE 양쪽 nav 에 [업무가이드] 가 있다', () => {
  const n = (wd.match(/data-v="guides"[^>]*>업무가이드/g) || []).length;
  assert.strictEqual(n, 2, `nav 버튼이 ${n}개 — 관리자/AE 두 벌이어야 한다`);
});

t('★ 광고주에게는 nav 자체가 없다(내부 업무 문서)', () => {
  // 광고주 분기는 nav 를 아예 렌더하지 않는다: `${isAdmin?`<nav…`:isStaff?`<nav…`:''}`
  const shell = wd.match(/\$\{isAdmin\?`<nav[\s\S]*?:''\}/);
  assert.ok(shell, 'nav 분기 구조가 바뀌었다 — 광고주 노출 여부를 다시 확인할 것');
  assert.ok(shell[0].trimEnd().endsWith(":''}"), '광고주 분기가 빈 문자열이 아니다');
});

t('switchView 라우팅이 연결돼 있다', () => {
  assert.ok(/v==='guides'\) renderGuidesView\(\)/.test(wd), 'switchView 분기가 없다');
  assert.ok(/function renderGuidesView\(\)/.test(wd), '렌더 함수가 없다');
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
