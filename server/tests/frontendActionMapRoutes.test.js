/**
 * frontendActionMapRoutes.test.js — 프론트 액션 이름 매핑(api.js GAS_ROUTE_MAP)이 가리키는 서버 입구가 실제로 있다.
 *
 * ★★ 사고(2026-10-04 · 결정 186 정정): 84번에서 `GET /api/diag/campaign-stats` 를 "호출 화면 0"으로 지웠는데,
 *   옛 대시보드 작업 목록의 [진행률] 버튼이 **경로가 아니라 액션 이름**(`gasPost({action:'getCampaignStats'})`)으로
 *   불러서 경로 grep 에 안 잡혔다 → 버튼을 누르면 오류. 서버 입구를 지울 때는 이 매핑도 같이 지워야 한다.
 *   93~95번 제거(시트 진단 3종 · /api/tab/stats · /api/admin/advertiser-users)와 [진행률] 버튼 제거 회귀가드 포함.
 *
 * 실행: node tests/frontendActionMapRoutes.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ═══ 서버 라우트 표 — app.js 마운트 × 라우트 파일 ═══ */
const app = read('server/src/app.js');
const reqMap = {};
for (const m of app.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/routes\/([\w.]+)'\)/g)) reqMap[m[1]] = m[2];
const routes = [];
for (const m of app.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(?:[\w.]+\s*,\s*)*(\w+)\s*\)/g)) {
  const file = reqMap[m[2]];
  if (!file) continue;
  const src = read('server/src/routes/' + (file.endsWith('.js') ? file : file + '.js'));
  for (const r of src.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/g)) {
    routes.push([r[1].toUpperCase(), m[1] + (r[2] === '/' ? '' : r[2])]);
  }
}
ok(`서버 라우트 표 구성(${routes.length}개)`, routes.length > 500);

const toRe = (p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$');
function exists(method, p) {
  return routes.some(([rm, rp]) => (rm === method || rm === 'ALL')
    && (toRe(rp).test(p) || rp.startsWith(p + '/:'))); // "/:id 는 호출 시 조합" 매핑 허용
}

/* ═══ api.js 매핑 전수 ═══ */
const api = read('frontend/api.js');
const missing = [];
let count = 0;
for (const m of api.matchAll(/'(\w+)'\s*:\s*\{\s*method:\s*'(\w+)'\s*,\s*path:\s*'([^']+)'/g)) {
  count++;
  const p = m[3].split('?')[0];
  if (!exists(m[2], p)) missing.push(`${m[1]} → ${m[2]} ${m[3]}`);
}
ok(`api.js 액션 매핑 ${count}개가 모두 실제 서버 입구를 가리킨다` + (missing.length ? '\n      → ' + missing.join('\n      → ') : ''),
  count > 50 && missing.length === 0);

/* 변이: 없는 입구는 잡는다 */
ok('변이: 지운 입구는 없음으로 판정', !exists('GET', '/api/diag/campaign-stats') && !exists('GET', '/api/tab/stats'));
ok('변이: 있는 입구는 있음으로 판정', exists('GET', '/api/admin/keywords') && exists('PUT', '/api/admin/keywords'));

/* ═══ 93~95번 · [진행률] 버튼 제거 고정 ═══ */
for (const [method, p] of [['POST', '/api/submit/debug-tabs'], ['GET', '/api/submit/diag-tabs'], ['GET', '/api/submit/slot-status'],
  ['GET', '/api/tab/stats'], ['POST', '/api/admin/advertiser-users'], ['PATCH', '/api/short/update-round']]) {
  ok(`${method} ${p} 제거 상태`, !exists(method, p));
}
ok('광고주 계정 관리는 3버전 입구가 남아 있다', exists('POST', '/api/trackb/advertiser-account'));
ok('97·98번 잔류 입구는 남아 있다', exists('GET', '/api/campaign/admin/popular-credit-audit') && exists('POST', '/api/trackb/workdesk/auto-finish'));
const admin = read('frontend/admin.html');
ok('옛 대시보드: 진행률 패널·스크립트 없음', !/statsPanelOverlay/.test(admin) && !/index-stats\.js/.test(admin));
ok('옛 대시보드: [진행률] 버튼 없음', !/openStatsPanel|btn-tab-stats/.test(read('frontend/js/index-app.js')));
ok('진행률 패널 스크립트 파일 없음', !fs.existsSync(path.join(root, 'frontend/js/index-stats.js')));

console.log(`\n✅ frontendActionMapRoutes: ${n}개 통과`);
