/**
 * shareLink.test.js — 회귀가드: 작업보드·업체 공유 링크 (migration 131)
 * 실행: node tests/shareLink.test.js
 *
 * 배경(직원 요청 2026-08-11): 택배·문의 인수인계 때 상대가 검색 탭에서 매번 그 작업을 찾아
 *   들어가야 했다. 이제 작업보드 상단 [🔗 링크 복사] 한 번이면 `.../workdesk#w=<code>` 가
 *   복사되고, 메신저로 받은 사람은 로그인 후 그 작업보드로 직행한다.
 *
 * 고정하는 것(완화 금지):
 *  A. 마이그레이션 — 신규 테이블만 · 대상마다 코드 1개(부분 유니크) = 주소가 안 바뀐다
 *  B. ★★ 링크는 권한이 아니다 — 되찾기가 canAccessTab 을 통과해야 하고, 실패 시 쓰기 0
 *  C. 같은 대상은 같은 코드(재발급 없음) · tab_gid 는 blank-only
 *  D. ★ 공유 주소에 토큰(admin_token)을 절대 싣지 않는다 — 세션을 넘겨주는 링크가 되면 안 된다
 *  E. 화면 배선 — #w= 수신 · 로그인 후 소비 · 버튼 · 실패 사유 고지
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const migration = read('migrations/131_trackb_share_links.sql');
const routes = read('src/routes/trackB.routes.js');
const svcSrc = read('src/services/shareLink.service.js');
const workdesk = read('../frontend/workdesk.html');

/* 스텁 pool — 서비스·라우트를 **실제로 실행**한다(정적 검사만으로는 `if(false&&…)` 를 통과시킨다). */
const _poolPath = require.resolve('../src/db/pool');
let _calls = [];
let _handler = () => ({ rows: [] });
require.cache[_poolPath] = {
  id: _poolPath, filename: _poolPath, loaded: true,
  exports: { query: async (sql, params) => { _calls.push({ sql, params }); return _handler(sql, params); } },
};

let passed = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
};
function routeBody(src, decl) {
  const i = src.indexOf(decl);
  assert(i > -1, '라우트를 찾지 못함: ' + decl);
  const j = src.indexOf('\nrouter.', i + 10);
  return src.slice(i, j > i ? j : src.length);
}
const writes = () => _calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql.trim()));

(async () => {

// ── A. 마이그레이션 ────────────────────────────────────────────
console.log('\n[A] 마이그레이션 131');
ok('신규 테이블만 — 기존 테이블 ALTER 0', /CREATE TABLE IF NOT EXISTS trackb_share_links/.test(migration)
  && !/\bALTER TABLE\b/i.test(migration));
ok('★ 백필 0 — UPDATE/INSERT 문이 없다', !/\b(UPDATE|INSERT)\s+/i.test(migration));
ok('★ 대상마다 코드 1개 — 작업 부분 유니크',
  /CREATE UNIQUE INDEX[\s\S]{0,140}\(sheet_id, tab_name\)\s*WHERE kind\s*=\s*'tab'/.test(migration));
ok('★ 대상마다 코드 1개 — 업체 부분 유니크',
  /CREATE UNIQUE INDEX[\s\S]{0,140}\(advertiser_id\)\s*WHERE kind\s*=\s*'advertiser'/.test(migration));
ok('업체 삭제 시 CASCADE(고아 링크 잔류 금지)', /REFERENCES advertisers\(id\) ON DELETE CASCADE/.test(migration));

// ── B. 라우터 스택 실검사 ──────────────────────────────────────
console.log('\n[B] 라우터 스택 실검사 — 등록 · 게이트');
const router = require('../src/routes/trackB.routes');
for (const [p, method] of [['/share-link', 'post'], ['/share-link/:code', 'get']]) {
  const layer = (router.stack || []).find(l => l.route && l.route.path === p && l.route.methods[method]);
  ok(method.toUpperCase() + ' ' + p + ' 가 등록돼 있다', !!layer);
  const names = layer.route.stack.map(s => s.name);
  ok(p + ' — authMiddleware 를 먼저 탄다', names[0] === 'authMiddleware', names.join(','));
  ok(p + ' — ★ internalMiddleware(광고주·리뷰어 도달 불가)',
    names.some(n => n === 'internalMiddleware'), names.join(','));
}

// ── C. 서비스 실행 — 같은 대상은 같은 코드 · blank-only ──────────
console.log('\n[C] 서비스 실행 — 코드 안정성');
const svc = require('../src/services/shareLink.service');
{
  _calls = []; _handler = sql => /SELECT code FROM trackb_share_links/.test(sql)
    ? { rows: [{ code: 'EXISTING01' }] } : { rows: [] };
  const r = await svc.ensureTabShareLink({ sheetId: 's1', tabName: '탭A', tabGid: '77', by: '만두' });
  ok('★ 이미 있으면 그 코드를 그대로 준다(주소가 바뀌지 않는다)', r.code === 'EXISTING01' && r.created === false, r);
  ok('★ 재발급 INSERT 를 하지 않는다', !_calls.some(c => /INSERT INTO trackb_share_links/i.test(c.sql)));
  const upd = _calls.find(c => /UPDATE trackb_share_links SET tab_gid/i.test(c.sql));
  ok('★ tab_gid 는 blank-only 보정(있는 값을 안 덮는다)',
    !!upd && /COALESCE\(tab_gid,''\)\s*=\s*''/.test(upd.sql), upd && upd.sql);
}
{
  _calls = []; _handler = sql => /INSERT INTO trackb_share_links/i.test(sql)
    ? { rows: [{ code: 'NEWCODE99' }] } : { rows: [] };
  const r = await svc.ensureTabShareLink({ sheetId: 's1', tabName: '탭A', by: '망고' });
  ok('없으면 발급한다', r.code === 'NEWCODE99' && r.created === true, r);
  const ins = _calls.find(c => /INSERT INTO trackb_share_links/i.test(c.sql));
  ok('★ 경합 안전 — ON CONFLICT DO NOTHING', /ON CONFLICT DO NOTHING/i.test(ins.sql));
  ok('★ 쓰기 표면 = trackb_share_links 한 곳',
    writes().every(c => /trackb_share_links/i.test(c.sql)), writes().map(c => c.sql.slice(0, 40)));
}
{
  _calls = []; _handler = () => ({ rows: [] });
  let threw = false;
  try { await svc.ensureTabShareLink({ sheetId: '', tabName: '탭A' }); } catch (e) { threw = e.status === 400; }
  ok('★ 대상이 비면 거부 — 쓰기 0', threw && writes().length === 0);
}
{
  _calls = []; _handler = sql => /SELECT code FROM trackb_share_links/.test(sql)
    ? { rows: [{ code: 'ADVCODE01' }] } : { rows: [] };
  const r = await svc.ensureAdvertiserShareLink({ advertiserId: 'adv_1', by: '만두' });
  ok('업체 링크도 같은 규칙(있으면 그대로)', r.code === 'ADVCODE01' && r.created === false);
}

// ── D. 되찾기 = 게이트 (라우트 실제 호출) ────────────────────────
console.log('\n[D] 되찾기 — ★★ 링크는 권한이 아니다');
function callGet(reqAdmin, row) {
  const layer = (router.stack || []).find(l => l.route && l.route.path === '/share-link/:code' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  _calls = []; _handler = sql => /FROM trackb_share_links/i.test(sql) ? { rows: row ? [row] : [] } : { rows: [] };
  const req = { params: { code: 'CODE1' }, admin: reqAdmin, query: {}, body: {} };
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); return this; },
    };
    Promise.resolve(handler(req, res, e => resolve({ status: 500, payload: { err: e && e.message } })));
  });
}
{
  const row = { code: 'CODE1', kind: 'tab', sheetId: 's1', tabName: '탭A', tabGid: '77' };
  // ★★ 사용자 확정 2026-08-19 — 내부 직원(master/admin/staff)은 이미 모든 작업보드를 열고 표까지
  //   편집한다(/workdesk 의 allowAllStaff). 링크에만 담당 스코프를 걸면 "목록엔 보이는데 링크로는
  //   안 열리는" 막다른 길이 된다. 그래서 게이트는 작업보드와 **같은 `_ensureEditScope`** 하나다.
  const r1 = await callGet({ role: 'staff', name: 'AE1' }, row);
  ok('★★ 내부 AE 는 담당이 아니어도 연다(작업보드와 같은 규칙)',
    r1.status === 200 && r1.payload.ok && r1.payload.tabName === '탭A', r1.payload);

  const r2 = await callGet({ role: 'advertiser', advertiser_id: 'adv_1' }, row);
  ok('★★ 광고주는 거부 — 탭 이름조차 주지 않는다(라우터 internalMiddleware 와 이중)',
    r2.status === 403 && !JSON.stringify(r2.payload).includes('탭A'), r2);
  ok('★ 거부 시 쓰기 0(열람 기록도 남기지 않는다)', writes().length === 0, writes().map(c => c.sql.slice(0, 40)));

  const r3 = await callGet({ role: 'admin', name: 'A' }, null);
  ok('★ 없는 코드는 404 로 사유를 말한다(조용한 홈 낙하 금지)',
    r3.status === 404 && /찾을 수 없/.test(r3.payload.error || ''), r3);
}

// ── E. 라우트 본문 계약 ────────────────────────────────────────
console.log('\n[E] 라우트 본문 계약');
{
  const body = routeBody(routes, "router.get('/share-link/:code'");
  ok('★★ 게이트는 작업보드와 같은 단일 출처(_ensureEditScope) — 두 번째 기준을 만들지 않는다',
    /_ensureEditScope\(req, row\.sheetId, row\.tabName\)/.test(body));
  ok('★ 스코프 판정 사본 0 — 이 라우트가 canAccessTab 을 따로 부르지 않는다',
    !/canAccessTab/.test(body));
  ok('★ 대상은 서버가 되찾은 row 기준(클라이언트가 준 값을 쓰지 않는다)',
    /row\.sheetId/.test(body) && !/req\.query\.(sheetId|tabName)/.test(body));
  ok('42P01/42703 은 not_ready 로 안내(131 미적용 무신호 금지)', /notReady\(err\)[\s\S]{0,160}not_ready/.test(body));
  ok('★ 이 라우트는 운영 테이블에 쓰지 않는다',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(campaign_participants|order_submissions|review_index|tab_configs)/i.test(body));
}

// ── F. 화면 배선 ──────────────────────────────────────────────
console.log('\n[F] 화면 배선(workdesk.html)');
ok('#w=<code> 를 해시에서 읽는다', /\[#&\]w=\(\[A-Za-z0-9_-\]\{4,64\}\)/.test(workdesk));
ok('★ 코드는 initToken(해시 제거)보다 먼저 집는다',
  workdesk.indexOf('function initShareLink') < workdesk.indexOf('function initToken'));
ok('★ 로그인 후에도 살아남아 소비된다(_SHARE 는 모듈 변수 · boot 재실행 시 소비)',
  /let _SHARE=null/.test(workdesk) && /await _consumeShare\(\)/.test(workdesk));
ok('소비 후 주소창에서 해시 제거(새로고침 재발동 방지)',
  /_consumeShare[\s\S]{0,400}history\.replaceState/.test(workdesk));
ok('작업 링크는 pendingTab 으로 예약(평소 로딩 경로 = 서버 스코프 재검증)',
  /_consumeShare[\s\S]{0,700}STATE\.pendingTab=\{ sheetId:r\.sheetId/.test(workdesk));
ok('업체 링크는 pendingAdv 로 예약', /_consumeShare[\s\S]{0,700}STATE\.pendingAdv=\{ id:r\.advertiserId \}/.test(workdesk));
ok('★ 실패 사유를 화면이 말한다(_SHARE_ERR)', /_SHARE_ERR[\s\S]{0,120}alert\(msg\)/.test(workdesk));
{
  const i = workdesk.indexOf('async function _shareLinkCopy');
  const body = workdesk.slice(i, workdesk.indexOf('function _shareLinkPopup'));
  ok('_shareLinkCopy 가 존재한다', i > 0);
  ok('★★ 공유 주소에 토큰을 싣지 않는다(세션을 넘겨주는 링크 금지)',
    !/sso=|admin_token|token\(\)/.test(body), body.slice(0, 400));
  ok('주소는 #w= 한 형태', /'#w='\s*\+\s*r\.code/.test(body));
  // ★★ 사용자 확정 2026-08-19 — 클릭 = 즉시 복사(주소를 눈으로 확인할 일이 없어 팝업을 거치지 않는다).
  ok('★ 성공하면 팝업 없이 중앙 알림만', /_copyText\(url\)[\s\S]{0,120}_shareLinkOk\(/.test(body));
  ok('★ 복사가 막힌 경우에만 주소 팝업(조용한 실패 금지)',
    /_shareLinkPopup\(title, url, false\)/.test(body));
}
{
  const i = workdesk.indexOf('function _shareLinkOk');
  const okBody = workdesk.slice(i, i + 800);
  ok('_shareLinkOk — 화면 중앙 알림이 있다', i > 0);
  ok('★ body 직속 · pointer-events:none(알림이 화면 조작을 막지 않는다)',
    /document\.body\.appendChild\(el\)/.test(okBody) && /#shlOk\{[^}]*pointer-events:none/.test(workdesk));
  ok('★ 문자열 보간 금지 — textContent 로 넣는다', /textContent=msg/.test(okBody));
  ok('★ 연타해도 겹치지 않는다(이전 알림 제거)', /getElementById\('shlOk'\);\s*if\(prev\) prev\.remove\(\)/.test(okBody));
  ok('★ 애니메이션 이벤트가 안 와도 반드시 사라진다(setTimeout 백스톱)', /setTimeout\(kill/.test(okBody));
  ok('페이드아웃 애니메이션 정의', /@keyframes shlFade\{/.test(workdesk) && /animation:shlFade/.test(workdesk));
  ok('★ 복사 단일 출처 _copyText(Clipboard → execCommand 폴백)',
    (workdesk.match(/async function _copyText/g) || []).length === 1
    && /navigator\.clipboard[\s\S]{0,200}document\.execCommand\('copy'\)/.test(workdesk));
}
ok('★ 팝업은 body 직속(스크롤 컨테이너 밖)', /_shareLinkPopup[\s\S]{0,600}document\.body\.appendChild\(ov\)/.test(workdesk));
ok('★ Esc 리스너는 최상위 1회만', /_shlKeyBound/.test(workdesk));
ok('작업보드 상단에 [🔗 링크 복사] — 광고주 제외',
  /const shareBtn=STATE\.role==='advertiser'\?''/.test(workdesk) && /onclick="copyBoardLink\(\)"/.test(workdesk));
ok('헤더에 실제로 그려진다', /\$\{shareBtn\}/.test(workdesk));
ok('업체관리 패널에 [🔗 업체 링크 복사]', /onclick="copyAdvertiserLink\(\)"/.test(workdesk));
ok('홈 작업목록 줄마다 [🔗 링크] — 인덱스만 넘긴다',
  /onclick="event\.stopPropagation\(\);copyTaskLinkFromHome\(\$\{i\}\)"/.test(workdesk));
ok('★ 줄 클릭(작업 열기)과 겹치지 않게 stopPropagation',
  /copyTaskLinkFromHome[\s\S]{0,80}/.test(workdesk) && /event\.stopPropagation\(\);copyTaskLinkFromHome/.test(workdesk));
ok('홈 목록 헤더에 공유 열(칸 수 ≡ 행 칸 수 — homeTasklistFilters 가 렌더 실행으로 계수)',
  /<th class="wbl-c">작업표<\/th><th class="wbl-c">공유<\/th>/.test(workdesk));
ok('★ 마감 보관함에도 같은 칸(모드마다 열 수가 달라지지 않는다) — tdLink 는 fin 분기가 없다',
  /const tdLink=`<td[^`]*`;/.test(workdesk) && !/const tdLink=`\$\{fin\?/.test(workdesk));
ok('복사 실행부는 _shareLinkCopy 한 벌(사본 금지)',
  (workdesk.match(/async function _shareLinkCopy/g) || []).length === 1
  && /function copyTaskLinkFromHome[\s\S]{0,320}_shareLinkCopy\(\{ kind:'tab'/.test(workdesk));
ok('★ 링크의 업체를 목록에서 못 찾으면 사유를 말한다',
  /pendingAdv[\s\S]{0,600}업체를 목록에서 찾지 못했습니다/.test(workdesk));

console.log(`\n✅ shareLink — ${passed} 케이스 통과`);
process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
