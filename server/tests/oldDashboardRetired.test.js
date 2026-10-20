/* 옛 관리자 대시보드 폐기 회귀가드 — 결정 267 (사용자 확정 2026-10-21)
 *
 * [A] 옛 화면 전용 파일 7개는 지워진 채로 남는다(되살리면 아무도 고치지 않는 두 번째 관리자 화면이 생긴다)
 * [B] admin.html 은 지우지 않고 "정류장"으로 남는다 — 지우면 /admin 이 Pages SPA 폴백으로 리뷰어 홈에 떨어진다
 *     · 예전 구매양식 링크(?mode=form · ?r= · ?s= · ?sheetId=) → search.html 로 쿼리·해시째
 *     · 그 밖 → workdesk.html 로 해시째(#sso= · #go= 등) — 같은 탭·같은 출처라 로그인(sessionStorage)이 이어진다
 *     인라인 스크립트를 vm 으로 실제 실행해 location.replace 목적지를 본다.
 * [C] 어떤 화면도 지운 파일을 싣지 않는다 · 리뷰어 홈 하단 링크는 작업보드로 간다
 *
 * 실행: node tests/oldDashboardRetired.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FE = path.join(__dirname, '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FE, p), 'utf8');

let n = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); n++; console.log('  ✓ ' + name); };

console.log('\n[A] 옛 화면 전용 파일은 지워진 상태');
const DELETED = ['js/index-app.js', 'js/index-register.js', 'js/index-stats.js', 'js/index-payment.js',
  'js/index-order-ledger.js', 'js/config.js', 'css/index.css'];
for (const f of DELETED) ok(`${f} 없음`, !fs.existsSync(path.join(FE, f)));

console.log('\n[B] admin.html = 정류장');
const stub = read('admin.html');
ok('admin.html 은 남아 있다(지우면 /admin 이 리뷰어 홈으로 떨어진다)', stub.length > 0);
ok('정류장은 다른 스크립트를 싣지 않는다(옛 화면 코드 0)', !/<script[^>]*\ssrc=/.test(stub));
ok('검색엔진 색인 제외', /<meta name="robots" content="noindex"\/?>/.test(stub));
ok('스크립트 없이도 사람이 누를 링크가 있다', /<a href="workdesk\.html">/.test(stub));
const inline = (stub.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
ok('이동 스크립트가 있다', !!inline);
const go = (search, hash) => {
  let target = null;
  const sb = { URLSearchParams, location: { search, hash, replace: (u) => { target = u; } } };
  vm.createContext(sb);
  vm.runInContext(inline, sb);
  return target;
};
const CASES = [
  ['', '', 'workdesk.html'],
  ['', '#sso=abc', 'workdesk.html#sso=abc'],
  ['', '#go=12', 'workdesk.html#go=12'],
  ['?foo=1', '', 'workdesk.html'],
  ['?mode=form&s=SID&g=1&t=탭', '', 'search.html?mode=form&s=SID&g=1&t=탭'],
  ['?r=AB12', '', 'search.html?r=AB12'],
  ['?s=SID', '', 'search.html?s=SID'],
  ['?sheetId=SID&tab=x', '#k', 'search.html?sheetId=SID&tab=x#k'],
  ['?mode=other', '', 'workdesk.html'],
  ['?r=', '', 'workdesk.html'],
];
for (const [search, hash, want] of CASES) {
  const got = go(search, hash);
  ok(`${JSON.stringify(search + hash)} → ${want}`, got === want, `실제 ${got}`);
}
ok('예전 양식 판정 파라미터가 search-app.js 가 읽는 것과 같다(mode=form · r · s · sheetId)',
  ['params.get("r")', 'params.get("s")', 'params.get("sheetId")', 'params.get("mode") === "form"']
    .every(k => read('js/search-app.js').includes(k)));

console.log('\n[C] 어떤 화면도 지운 파일을 싣지 않는다');
const htmls = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp);
    else if (e.name.endsWith('.html')) htmls.push(fp);
  }
})(FE);
const loaders = [];
for (const fp of htmls) {
  const s = fs.readFileSync(fp, 'utf8');
  for (const f of DELETED) {
    // 파일명 앞은 경로 구분자 또는 따옴표만 — js/search-config.js 가 config.js 로 잡히지 않게
    const base = f.replace(/^(js|css)\//, '').replace(/\./g, '\\.');
    if (new RegExp(`<(script|link)[^>]*(src|href)="(?:[^"]*\\/)?${base}(\\?[^"]*)?"`).test(s)) loaders.push(path.relative(FE, fp) + ' → ' + f);
  }
}
ok(`프론트 HTML ${htmls.length}개 중 지운 파일을 싣는 곳 0`, loaders.length === 0, loaders.join(', '));
const home = read('index.html');
ok('리뷰어 홈 하단에 옛 /admin 링크가 없다', !/href="\/admin(\.html)?"/.test(home));
ok('리뷰어 홈 하단 관리자 링크는 작업보드로 간다', /<a href="workdesk\.html">관리자이신가요\?/.test(home));

console.log(`\n✅ oldDashboardRetired: ${n}개 통과`);
