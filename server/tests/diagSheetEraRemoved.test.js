// 시트 시절 임시 진단 10종 · 모집공고 편집기 미리보기 페이지 제거 회귀가드 (2026-10-04 · 결정 186 100·102번)
//   화면·스크립트 호출 0 · 운영 로그 9/2 이후 0. 일부는 시트 줄(이름·연락처)을 그대로 돌려줬다.
//   101번 worktable/dup-watch 는 잔류(관리자 전용 · 읽기 전용) — 남아 있는지도 고정한다.
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name, cond) => { if (!cond) { console.error('❌ ' + name); process.exit(1); } n++; console.log('  ✓ ' + name); };
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const diag = read('server/src/routes/diag.routes.js');
const re = (p) => new RegExp(`router\\.(get|post|put|patch|delete|all)\\(\\s*['"\`]/${p.replace(/-/g, '\\-')}['"\`]`);

for (const p of ['tab-gid-check', 'dashboard-check', 'dashboard-roundlist', 'round-check', 'drive-diag',
  'payment-check', 'sse-status', 'debug-parse', 'archive-detect-debug', 'slot-locks']) {
  ok(`diag /${p} 제거 상태`, !re(p).test(diag));
}
ok('변이: 되살린 라우트는 잡힌다', re('slot-locks').test("router.get('/slot-locks', authMiddleware, h)"));
ok('실시간 알림 연결 자체(events)는 남아 있다', /router\.get\('\/events'/.test(diag));
ok('101번 잔류: worktable/dup-watch', /router\.post\('\/worktable\/dup-watch', authMiddleware, adminOrMasterMiddleware/.test(read('server/src/routes/trackB.routes.js')));
ok('102번: 모집공고 편집기 미리보기 페이지 없음',
  !fs.existsSync(path.join(root, 'frontend/recruit-editor-runtime-preview.html'))
  && !fs.existsSync(path.join(root, 'frontend/recruit-editor-runtime-preview.test.js')));

console.log(`\n✅ diagSheetEraRemoved: ${n}개 통과`);
