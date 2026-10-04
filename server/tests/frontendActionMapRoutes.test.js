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
// ★ gasGet/gasPost 는 route.path 만 붙이고 주석의 '/:id…' 꼬리를 붙이지 않는다(Codex P2) — 동적 매핑을 화면이 부르면 404.
//   2026-10-04 기준 8개 모두 실제 화면 호출 0(시안 mockups 만). 아래 역방향 검사에서 "부르면 실패"로 고정한다.
const dynamicNames = new Set();
for (const m of api.matchAll(/'(\w+)'\s*:\s*\{\s*method:\s*'(\w+)'\s*,\s*path:\s*'([^']+)'[^\n]*/g)) {
  count++;
  mapNames.add(m[1]);
  const p = m[3].split('?')[0];
  const tail = m[0].slice(m[0].indexOf('}'));
  const dyn = (tail.match(/\/\/[^\n]*?(\/:[\w/:]+)/) || [])[1] || '';
  if (!exists(m[2], p, dyn)) missing.push(`${m[1]} → ${m[2]} ${m[3]}${dyn}`);
  if (dyn) dynamicNames.add(m[1]);
}
ok(`api.js 액션 매핑 ${count}개가 모두 실제 서버 입구를 가리킨다` + (missing.length ? '\n      → ' + missing.join('\n      → ') : ''),
  count > 50 && missing.length === 0);

/* ═══ 반대 방향: 화면이 부르는 액션 이름이 매핑에 있다(Codex P2) ═══
 * 매핑이 없으면 gasGet/gasPost 가 "알 수 없는 action" 으로 끝난다 — 버튼은 있는데 아무 일도 안 남.
 * KNOWN_DEAD = 이 가드를 세울 때(2026-10-04) 이미 매핑 없던 구글시트 시절 버튼 3개. 결정 186 다음 항목에서 처리한다 —
 * 여기에 새 이름을 더하지 말 것(새 버튼은 매핑을 만들거나 버튼을 지운다). */
const KNOWN_DEAD = new Set(['cleanOrphanDetailRows', 'debugBuildStep', 'testTabConfig', 'debugSingleSheet']);
// gas 래퍼가 아닌 헬퍼 본문의 하위 동작 이름(예: _campEditorAction({action:'add'})) — 액션 매핑 대상이 아니다.
const SUB_ACTIONS = new Set(['add', 'toggle', 'remove', 'edit', 'delete', 'list']);
const unmapped = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'docs', 'mockups'].includes(e.name)) walk(f); continue; }
    if (!/\.(js|html)$/.test(e.name) || /\.test\.js$/.test(e.name) || e.name === 'api.js') continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!/gas(?:Get|Post|PostUpload)\(/.test(src)) continue;
    // 호출 안 직접 리터럴 + 변수에 먼저 담는 형태(const p = { action: '…' }) 모두 — Codex P2
    for (const m of src.matchAll(/action\s*:\s*["'](\w+)["']/g)) {
      const a = m[1];
      if (SUB_ACTIONS.has(a) || KNOWN_DEAD.has(a)) continue;
      if (!mapNames.has(a)) unmapped.push(`${path.relative(root, f)}: ${a}`);
      else if (dynamicNames.has(a)) unmapped.push(`${path.relative(root, f)}: ${a}(동적 매핑 — 래퍼가 /:id 를 안 붙여 404)`);
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
// 전역에서 부를 수 있는 함수만 센다(Codex P2): 옛 대시보드 스크립트를 **실제로 한 번 실행**(가짜 브라우저 객체)하고
//   인라인 핸들러가 부르는 이름이 전역에서 함수인지 vm 안에서 typeof 로 확인한다.
//   IIFE·DOMContentLoaded 안으로 숨은 함수는 여기서 undefined 로 잡힌다. 실행 중 오류는 스크립트 단위로 삼킨다
//   (함수 선언은 실행 전에 만들어지므로 오류 뒤 함수도 잡힌다).
const vm = require('vm');
const any = () => { const f = function () { return p; }; const p = new Proxy(f, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : p), apply: () => p, construct: () => p, set: () => true, has: () => true }); return p; };
const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
const sandbox = { console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, document: any(), navigator: any(), location: any(), history: any(),
  localStorage: store(), sessionStorage: store(), fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, alert() {}, confirm: () => false, prompt: () => null, matchMedia: () => any(), getComputedStyle: () => any(),
  EventSource: any(), MutationObserver: any(), IntersectionObserver: any(), ResizeObserver: any(), CustomEvent: any(), Event: any(), HTMLElement: any(), Element: any(), Node: any(), Image: any(), FileReader: any(), Blob: any(), FormData: any(), AbortController: any(), DOMParser: any(), XMLHttpRequest: any(),
  URL, URLSearchParams, Intl, Date, Math, JSON, Promise, Map, Set, WeakMap, Array, Object, String, Number, Boolean, RegExp, Error, Symbol, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, TextEncoder, TextDecoder, structuredClone, atob, btoa };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const runErrors = [];
for (const src of scripts) { const fp = path.join(root, 'frontend', src); if (!fs.existsSync(fp)) continue; try { vm.runInContext(fs.readFileSync(fp, 'utf8'), ctx, { filename: src, timeout: 5000 }); } catch (e) { runErrors.push(src + ': ' + String(e.message).slice(0, 60)); } }
for (const m of admin.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) { try { vm.runInContext(m[1], ctx, { timeout: 5000 }); } catch (e) { runErrors.push('inline: ' + String(e.message).slice(0, 60)); } }
const isGlobalFn = (fn) => { try { return vm.runInContext(`typeof ${fn} === 'function'`, ctx); } catch (_) { return false; } };
const called = new Set();
for (const a of admin.matchAll(/\son[a-z]+="([^"]*)"/g)) {
  for (const m of a[1].matchAll(/(^|[^\w$.])(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[2]);
}
const BUILTIN = new Set(['if', 'return', 'event', 'this', 'document', 'window', 'alert', 'confirm', 'location', 'history', 'setTimeout',
  'function', 'String', 'Number', 'parseInt', 'encodeURIComponent', 'decodeURIComponent', 'JSON', 'Math', 'open', 'print', 'fetch', 'while', 'for', 'switch', 'var', 'rgba', 'rgb', 'url']); // var·rgba·url = 핸들러 안 CSS 문자열
const undef = [...called].filter(fn => !BUILTIN.has(fn) && !isGlobalFn(fn));
ok(`옛 대시보드 인라인 버튼이 부르는 함수 ${called.size}개가 모두 정의돼 있다` + (undef.length ? ' → 없음: ' + undef.join(', ') : ''), undef.length === 0);

console.log(`\n✅ frontendActionMapRoutes: ${n}개 통과`);
