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
const norm = (t) => t.replace(/:\w+/g, ':x');
// dynamicSuffix = 매핑 주석에 적힌 정확한 동적 꼬리(예: '/:id/status'). 있으면 그 **완전한 템플릿**이 서버에 있어야 한다(Codex P2 — 접두 일치 금지).
function exists(method, p, dynamicSuffix = '') {
  return routes.some(([rm, rp]) => (rm === method || rm === 'ALL')
    && (dynamicSuffix ? norm(rp) === norm(p + dynamicSuffix) : toRe(rp).test(p)));
}

/* ═══ api.js 매핑 전수 ═══ */
const api = read('frontend/api.js');
const missing = [];
let count = 0;
const mapNames = new Set();
for (const m of api.matchAll(/'(\w+)'\s*:\s*\{\s*method:\s*'(\w+)'\s*,\s*path:\s*'([^']+)'[^\n]*/g)) {
  count++;
  mapNames.add(m[1]);
  const p = m[3].split('?')[0];
  const tail = m[0].slice(m[0].indexOf('}'));
  const dyn = (tail.match(/\/\/[^\n]*?(\/:[\w/:]+)/) || [])[1] || '';
  if (!exists(m[2], p, dyn)) missing.push(`${m[1]} → ${m[2]} ${m[3]}${dyn}`);
}
ok(`api.js 액션 매핑 ${count}개가 모두 실제 서버 입구를 가리킨다` + (missing.length ? '\n      → ' + missing.join('\n      → ') : ''),
  count > 50 && missing.length === 0);

/* ═══ 반대 방향: 화면이 부르는 액션 이름이 매핑에 있다(Codex P2) ═══
 * 매핑이 없으면 gasGet/gasPost 가 "알 수 없는 action" 으로 끝난다 — 버튼은 있는데 아무 일도 안 남.
 * KNOWN_DEAD = 이 가드를 세울 때(2026-10-04) 이미 매핑 없던 구글시트 시절 버튼 3개. 결정 186 다음 항목에서 처리한다 —
 * 여기에 새 이름을 더하지 말 것(새 버튼은 매핑을 만들거나 버튼을 지운다). */
const KNOWN_DEAD = new Set(['cleanOrphanDetailRows', 'debugBuildStep', 'testTabConfig']);
const unmapped = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'docs'].includes(e.name)) walk(f); continue; }
    if (!/\.(js|html)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/gas(?:Get|Post|PostUpload)\(\s*\{\s*action\s*:\s*["'](\w+)["']/g)) {
      if (!mapNames.has(m[1]) && !KNOWN_DEAD.has(m[1])) unmapped.push(`${path.relative(root, f)}: ${m[1]}`);
    }
  }
})(path.join(root, 'frontend'));
ok('화면이 부르는 액션 이름은 모두 매핑에 있다' + (unmapped.length ? '\n      → ' + unmapped.join('\n      → ') : ''), unmapped.length === 0);

/* 변이: 없는 입구는 잡는다 */
ok('변이: 지운 입구는 없음으로 판정', !exists('GET', '/api/diag/campaign-stats') && !exists('GET', '/api/tab/stats'));
ok('변이: 있는 입구는 있음으로 판정', exists('GET', '/api/admin/keywords') && exists('PUT', '/api/admin/keywords', '/:id'));
ok('변이: 동적 표시 없는 매핑은 접두 일치로 통과시키지 않는다', !exists('PUT', '/api/admin/keywords'));
ok('변이: 동적 꼬리는 완전한 템플릿만 인정', exists('PUT', '/api/campaign/admin', '/:id/status') && !exists('PUT', '/api/campaign/admin', '/:id/nope'));

/* ═══ 93~95번 · [진행률] 버튼 제거 고정 ═══ */
for (const [method, p] of [['POST', '/api/submit/debug-tabs'], ['GET', '/api/submit/diag-tabs'], ['GET', '/api/submit/slot-status'],
  ['GET', '/api/tab/stats'], ['POST', '/api/admin/advertiser-users'], ['PATCH', '/api/short/update-round']]) {
  ok(`${method} ${p} 제거 상태`, !exists(method, p));
}
ok('광고주 계정 관리는 3버전 입구가 남아 있다', exists('POST', '/api/trackb/advertiser-account'));
ok('97·98번 잔류 입구는 남아 있다', exists('GET', '/api/campaign/admin/popular-credit-audit') && exists('POST', '/api/trackb/workdesk/auto-finish'));
const admin = read('frontend/admin.html');
ok('옛 대시보드: 진행률 패널 화면 없음', !/statsPanelOverlay/.test(admin));
ok('옛 대시보드: [진행률] 버튼 없음', !/openStatsPanel|btn-tab-stats/.test(read('frontend/js/index-app.js')));
// ★ 84-정정의 정정(Codex P1): index-stats.js 에는 블랙리스트·공지 배너 창도 있었다 — 파일째 지우면 그 버튼이 죽는다.
const stats = read('frontend/js/index-stats.js');
ok('진행률 패널 함수는 없다', !/function openStatsPanel|function _renderStatsPanel/.test(stats));
ok('블랙리스트·공지 배너 창 함수는 남아 있고 옛 대시보드가 불러온다',
  ['openBlPanel', 'closeBlPanel', 'loadBlacklist', 'addBlacklist', 'removeBlacklist', 'openNoticePanel', 'closeNoticePanel', 'saveNotice', 'clearNotice']
    .every(fn => new RegExp('function ' + fn + '\\b').test(stats))
  && /<script src="js\/index-stats\.js"><\/script>/.test(admin));

/* ═══ 옛 대시보드 인라인 핸들러가 부르는 함수는 어딘가에 정의돼 있다 ═══
 * 공유 스크립트를 지울 때 같이 사라지는 버튼을 잡는다(이번에 실제로 놓쳤다). */
const scripts = [...admin.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
const defined = new Set();
const addDefs = (src) => { for (const m of src.matchAll(/(?:function\s+|(?:window\.|^|[\s;])(?:const|let|var)?\s*)([A-Za-z_$][\w$]*)\s*(?:\(|=\s*(?:async\s*)?(?:function|\())/gm)) defined.add(m[1]); };
for (const s of scripts) { const fp = path.join(root, 'frontend', s); if (fs.existsSync(fp)) addDefs(fs.readFileSync(fp, 'utf8')); }
for (const m of admin.matchAll(/<script>([\s\S]*?)<\/script>/g)) addDefs(m[1]);
// 인라인 핸들러 값 안의 **모든** 함수 호출(맨 앞·세미콜론 뒤·조건 뒤·window.fn 포함, 멤버 호출 a.b() 는 제외) — Codex P2
const called = new Set();
for (const a of admin.matchAll(/\son[a-z]+="([^"]*)"/g)) {
  for (const m of a[1].matchAll(/(^|[^\w$.])(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[2]);
}
const BUILTIN = new Set(['if', 'return', 'event', 'this', 'document', 'window', 'alert', 'confirm', 'location', 'history', 'setTimeout',
  'function', 'String', 'Number', 'parseInt', 'encodeURIComponent', 'decodeURIComponent', 'JSON', 'Math', 'open', 'print', 'fetch', 'while', 'for', 'switch']);
const undef = [...called].filter(fn => !BUILTIN.has(fn) && !defined.has(fn));
ok(`옛 대시보드 인라인 버튼이 부르는 함수 ${called.size}개가 모두 정의돼 있다` + (undef.length ? ' → 없음: ' + undef.join(', ') : ''), undef.length === 0);

console.log(`\n✅ frontendActionMapRoutes: ${n}개 통과`);
