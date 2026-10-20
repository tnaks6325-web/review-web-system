/* 옛 관리자 대시보드 폐기 회귀가드 — 결정 267 (사용자 확정 2026-10-21)
 *
 * [A] 옛 화면 전용 파일 8개(admin.html 포함)는 지워진 채로 남는다
 *     (되살리면 아무도 고치지 않는 두 번째 관리자 화면이 생긴다).
 *     ★ admin.html 진입 경로까지 삭제(사용자 확정 2026-10-21 "진입경로를 없애도 되는지 확인 후" → 진행).
 *       /admin 은 Pages SPA 폴백으로 리뷰어 홈(200)에 떨어진다 — 직원은 리뷰어 홈 [관리자] → 인트라넷 → 작업보드로 간다.
 * [B] 어떤 화면·스크립트도 옛 주소(admin.html · /admin)로 보내지 않는다(주석 제외) · _redirects 에 /admin 규칙 없음
 *     · 리뷰어 홈 하단 관리자 링크는 작업보드로 간다
 * [C] 예전 구매양식 파라미터(mode=form · r · s · sheetId)는 리뷰어 구매양식(search-app.js)이 계속 읽는다
 *
 * 실행: node tests/oldDashboardRetired.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FE = path.join(__dirname, '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FE, p), 'utf8');

let n = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); n++; console.log('  ✓ ' + name); };

console.log('\n[A] 옛 화면 파일은 지워진 상태');
const DELETED = ['admin.html', 'js/index-app.js', 'js/index-register.js', 'js/index-stats.js', 'js/index-payment.js',
  'js/index-order-ledger.js', 'js/config.js', 'css/index.css'];
for (const f of DELETED) ok(`${f} 없음`, !fs.existsSync(path.join(FE, f)));

console.log('\n[B] 옛 주소로 보내는 곳 0');
// 주석(/* */ · <!-- --> · 줄 주석)은 빼고 본다 — 공유 모듈 머리말의 "원래 admin.html 에 있던…" 같은 이력 설명은 링크가 아니다.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
// admin.html 문자열 · 따옴표 바로 뒤의 /admin(끝·?·#·따옴표) — '/api/admin/...' 같은 API 경로는 걸리지 않는다
const OLD_ENTRY = /admin\.html|["'`]\/admin(?:["'`?#]|$)/m;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'docs') walk(fp); }
    else if (/\.(html|js)$/.test(e.name)) files.push(fp);
  }
})(FE);
const hits = [];
for (const fp of files) {
  const s = stripComments(fs.readFileSync(fp, 'utf8'));
  const m = s.match(OLD_ENTRY);
  if (m) hits.push(path.relative(FE, fp) + ' → ' + m[0]);
}
ok(`프론트 화면·스크립트 ${files.length}개(docs 제외) 중 옛 주소로 보내는 곳 0`, hits.length === 0, hits.join(', '));
const loaders = [];
for (const fp of files.filter(f => f.endsWith('.html'))) {
  const s = fs.readFileSync(fp, 'utf8');
  for (const f of DELETED.filter(x => x !== 'admin.html')) {
    // 파일명 앞은 경로 구분자 또는 따옴표만 — js/search-config.js 가 config.js 로 잡히지 않게
    const base = f.replace(/^(js|css)\//, '').replace(/\./g, '\\.');
    if (new RegExp(`<(script|link)[^>]*(src|href)="(?:[^"]*\\/)?${base}(\\?[^"]*)?"`).test(s)) loaders.push(path.relative(FE, fp) + ' → ' + f);
  }
}
ok('어떤 화면도 지운 스크립트·스타일을 싣지 않는다', loaders.length === 0, loaders.join(', '));
const redirects = fs.existsSync(path.join(FE, '_redirects')) ? read('_redirects') : '';
ok('_redirects 에 /admin 규칙이 없다(옛 주소를 어디로도 살려 두지 않는다)',
  !redirects.split('\n').some(l => /^\s*\/admin(\.html)?(\s|$)/.test(l)));
const home = read('index.html');
ok('리뷰어 홈에 옛 /admin 링크가 없다', !/href="\/admin(\.html)?"/.test(home));
ok('리뷰어 홈 하단 관리자 링크는 작업보드로 간다', /<a href="workdesk\.html">관리자이신가요\?/.test(home));

console.log('\n[C] 예전 구매양식 링크 파라미터는 리뷰어 구매양식이 읽는다');
ok('search-app.js 가 mode=form · r · s · sheetId 를 읽는다',
  ['params.get("r")', 'params.get("s")', 'params.get("sheetId")', 'params.get("mode") === "form"']
    .every(k => read('js/search-app.js').includes(k)));

console.log(`\n✅ oldDashboardRetired: ${n}개 통과`);
