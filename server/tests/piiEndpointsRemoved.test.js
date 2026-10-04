// 개인정보가 새던 안 쓰는 입구 5개 제거 회귀가드 (2026-10-04 · 결정 186 92번)
//
// 왜: authMiddleware 는 서명만 본다 → 리뷰어 세션·광고주 링크 토큰도 통과한다. 그 상태에서
//   - GET /api/reviewer/inaed-list  : 리뷰어 전원 이름·전화·주민번호·타계정
//   - GET /api/diag/inaed-list      : 같은 명단(diag 는 /viewer·/image·/blacklist 에도 마운트)
//   - GET /api/reviewer/my-applications : 인증 없이 번호 8자리만으로 신청 이력
//   - GET /api/reviewer/my-payments     : 인증 없이 번호 8자리 → 이름 매칭 입금 내역(동명이인 포함)
//   - GET /api/submit/debug-headers     : 인증 없이 시트 한 줄 전체
// 화면 호출 0 · 운영 로그 9/2 이후 호출 0 을 확인하고 제거했다. 되살리지 않는다(완화 금지).
const fs = require('fs');
const path = require('path');

let passed = 0;
function ok(name, cond) {
  if (!cond) { console.error(`❌ ${name}`); process.exit(1); }
  passed++; console.log(`  ✓ ${name}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const TARGETS = [
  ['src/routes/reviewer.routes.js', '/inaed-list'],
  ['src/routes/reviewer.routes.js', '/my-applications'],
  ['src/routes/reviewer.routes.js', '/my-payments'],
  ['src/routes/diag.routes.js', '/inaed-list'],
  ['src/routes/submit.routes.js', '/debug-headers'],
];
const routeRe = (p) => new RegExp(`router\\.(get|post|put|patch|delete|all|use)\\(\\s*['"\`]${p.replace(/[-/]/g, '\\$&')}['"\`]`);

for (const [file, p] of TARGETS) {
  ok(`${file} ${p}: 라우트 없음`, !routeRe(p).test(read(file)));
}

// 검사 자체가 살아 있는지(변이 확인): 되살린 코드를 넣으면 잡혀야 한다.
ok('변이: 되살린 라우트를 잡는다', routeRe('/my-payments').test("router.get('/my-payments', async (req, res) => {}"));
ok('변이: 공백·따옴표 변형도 잡는다', routeRe('/inaed-list').test('router.get( "/inaed-list", authMiddleware, h)'));
ok('변이: 이름이 다른 라우트는 오탐하지 않는다', !routeRe('/inaed-list').test("router.get('/get-inaed-list', h)"));

// 프론트가 다시 부르기 시작하지 않았는지(부르면 화면이 404 로 막힌다)
const frontDir = path.join(__dirname, '..', '..', 'frontend');
const hits = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); continue; }
    if (!/\.(js|html)$/.test(e.name)) continue;
    const s = fs.readFileSync(f, 'utf8');
    if (/reviewer\/(inaed-list|my-applications|my-payments)|diag\/inaed-list|submit\/debug-headers|[?&]action=(myApplications|myPayments)\b/.test(s)) hits.push(path.relative(frontDir, f));
  }
})(frontDir);
ok(`프론트에서 제거된 입구를 부르지 않음 (${hits.join(', ') || '0곳'})`, hits.length === 0);

console.log(`\n✅ piiEndpointsRemoved: ${passed}개 통과`);
