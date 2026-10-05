/**
 * workboardWorktabs.test.js — "열린 작업 줄"(개인별) 회귀가드 (M2)
 *   ※ 같은 M2 의 "오늘 완료"(전사 공통 체크)는 2026-09-30 코드 다이어트(결정 186 · 킵 재검토 7번)로 제거했다.
 *     9월 한 달 호출 0건 · 운영 체크 0건 실측. 표(trackb_tab_daily_done)는 보존(migration 검사 유지) —
 *     4)·5)·7) 이 입구·서비스·응답·화면 잔재 0 을 고정한다. 아래 ①②⑤ 는 제거 전 설계 기록으로 남긴다.
 * 실행: node tests/workboardWorktabs.test.js
 * 설계: frontend/docs/prd-workboard-worktabs.html (v1.2, 사용자 확정) · migration 089 · M1(088) 후속
 *
 * 이 변경에서 깨지면 아픈 것 여섯.
 *  ① **두 상태의 혼동** — "오늘 완료"(뒤로+회색, 다음날 자동 해제)와 "마감"(보드에서 제거, 영구)은
 *     다른 것이다. 오늘 완료가 목록에서 **사라지면** 오늘 몫을 끝낸 작업을 다시 열 수 없고, 마감이
 *     자동 해제되면 끝난 작업이 매일 아침 되살아난다. → 두 규칙을 각각 고정한다.
 *  ② **자정 리셋** — 판정이 "done_date = KST 오늘"이라 **크론이 없다**. 날짜 비교를 잃고 boolean
 *     컬럼으로 바꾸는 순간 어제 체크가 영원히 남는다(그리고 그걸 지울 배치가 필요해진다).
 *  ③ **순서 보존** — 열린 줄의 순서 = 사용자가 드래그로 정한 탭 배치. 즐겨찾기(Set)에 얹으면 사라진다.
 *  ④ **부팅 경합** — 부팅 조회가 사용자의 첫 클릭보다 늦게 도착하면 방금 연 탭을 덮어쓴다(실측).
 *  ⑤ **권한** — 오늘 완료도 전사 공통 쓰기다(staff 전체 탭·광고주 차단). authMiddleware 선행 필수.
 *  ⑥ **CSS/스크립트 무결성** — 주석 조기 종료가 규칙을 통째로 삼키고 브라우저는 에러 없이 넘어간다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const normalizeEol = s => s.replace(/\r\n/g, '\n');
const F = p => normalizeEol(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8'));
const S = p => normalizeEol(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 열린 작업 줄 회귀가드 (M2)\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const ROUTES = S('src/routes/trackB.routes.js');
const SVC_SRC = S('src/services/trackB.service.js');
const MIG = S('migrations/089_trackb_worktabs_daily.sql');

/* ── 1) 마이그레이션 ─────────────────────────────────────────── */
console.log('1) migration 089');
t('열린 작업 줄 테이블(계정당 1행)', /CREATE TABLE IF NOT EXISTS trackb_workdesk_worktabs[\s\S]{0,200}owner_key\s+TEXT PRIMARY KEY/.test(MIG));
t('★ 순서 있는 배열로 저장(JSONB) — 즐겨찾기처럼 Set 으로 접으면 드래그 순서가 사라진다', /tabs\s+JSONB/.test(MIG));
t('오늘 완료 테이블 + 날짜 컬럼', /CREATE TABLE IF NOT EXISTS trackb_tab_daily_done[\s\S]{0,300}done_date\s+DATE NOT NULL/.test(MIG));
t('★★ 판정이 날짜라 자정 리셋 크론이 필요 없다(boolean 컬럼으로 바꾸면 어제 체크가 영원히 남는다)',
  /done_date\s+DATE/.test(MIG) && !/is_done\s+BOOLEAN/i.test(MIG));
t('같은 탭·같은 날 중복 불가(멱등 upsert 의 충돌 대상)',
  /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*?trackb_tab_daily_done \(sheet_id, tab_name, done_date\)/.test(MIG));
t('IF NOT EXISTS(재실행 idempotent)', (MIG.match(/IF NOT EXISTS/g) || []).length >= 4);
t('FK 미사용(참조 타입 불일치로 파일 전체가 롤백되는 계열 사고 차단)', !/REFERENCES/i.test(MIG));
t('되돌리기 방법이 주석에 있다', /되돌리기/.test(MIG));

/* ── 2) 권한 — 라우터 스택 실검사 ─────────────────────────────── */
console.log('\n2) 권한 (라우터 스택 실검사)');
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});
t('GET /workdesk/worktabs 등록 + authMiddleware 선행', (L['GET /workdesk/worktabs'] || [])[0] === 'authMiddleware');
t('POST /workdesk/worktabs 등록 + authMiddleware 선행', (L['POST /workdesk/worktabs'] || [])[0] === 'authMiddleware');
t('★ 오늘 완료 입구(POST /workdesk/tab-daily-done)는 제거됐다(2026-09-30 다이어트)', !L['POST /workdesk/tab-daily-done'] && !/tab-daily-done/.test(ROUTES));
t('★ 열린 작업 줄은 **개인 데이터**라 스코프 게이트가 없다(자기 것만 읽고 쓴다 — 즐겨찾기와 같은 계약)',
  !/worktabs'[\s\S]{0,300}_ensureEditScope/.test(ROUTES));

/* ── 3) 서비스 실행(스텁 pool) ────────────────────────────────── */
console.log('\n3) 서비스 실행');
const pool = require('../src/db/pool');
const svc = require('../src/services/trackB.service');
const origQuery = pool.query.bind(pool);
let SQL = [];
const stub = (impl) => { SQL = []; pool.query = async (q, p) => { SQL.push({ q: String(q), p }); return impl ? impl(String(q), p) : { rows: [], rowCount: 0 }; }; };

(async () => {
  // ── 열린 작업 줄 ──
  stub(() => ({ rows: [], rowCount: 1 }));
  const saved = await svc.setWorkdeskWorktabs('만두', ['a', 'b', 'c']);
  t('열린 줄 저장(계정당 1행 upsert)', saved.ok === true && saved.count === 3
    && /ON CONFLICT \(owner_key\) DO UPDATE/.test(SQL[0].q));
  t('★ 순서를 그대로 직렬화(정렬·Set 금지)', JSON.parse(SQL[0].p[1]).join(',') === 'a,b,c');

  stub(() => ({ rows: [], rowCount: 1 }));
  await svc.setWorkdeskWorktabs('만두', ['c', 'a', 'b']);
  t('★ 재정렬도 그 순서 그대로(드래그 결과가 곧 저장값)', JSON.parse(SQL[0].p[1]).join(',') === 'c,a,b');

  stub(() => ({ rows: [], rowCount: 1 }));
  await svc.setWorkdeskWorktabs('만두', ['a', 'b', 'a', 'c']);
  t('중복 제거(첫 등장 순서 유지)', JSON.parse(SQL[0].p[1]).join(',') === 'a,b,c');

  stub(() => ({ rows: [], rowCount: 1 }));
  const capped = await svc.setWorkdeskWorktabs('만두', Array.from({ length: 30 }, (_, i) => 'k' + i));
  t('★ 상한 12 — 넘겨도 **저장 거부가 아니라** 잘라 담는다(요청을 튕기면 화면이 멈춘다)',
    capped.ok === true && capped.count === 12 && capped.cap === 12 && JSON.parse(SQL[0].p[1]).length === 12);

  pool.query = async () => { const e = new Error('nope'); e.code = '42P01'; throw e; };
  const gw = await svc.getWorkdeskWorktabs('만두');
  t('★ 조회 실패해도 화면은 죽지 않는다(빈 줄)', JSON.stringify(gw.tabs) === '[]');
  t('★★ 실패를 ok:false 로 **구분**한다 — 빈 배열만 주면 프론트가 "저장된 줄 없음"으로 신뢰해 로컬을 덮고, 다음 저장에서 서버 행이 통째로 대체된다(사용자 데이터 영구 삭제)',
    gw.ok === false);
  const sw = await svc.setWorkdeskWorktabs('만두', ['a']);
  t('★ 저장의 42P01 도 진단 가능한 메시지로(프론트 catch 가 삼켜 무신호가 되던 경로)',
    sw.ok === false && sw.code === 'not_ready' && /089/.test(sw.error));

  /* ── 4) 오늘 완료 제거 고정 ───────────────────────────────── */
  console.log('\n4) 오늘 완료 제거 고정 (2026-09-30)');
  t('서비스에서 오늘 완료 조회·토글 함수가 빠졌다', svc.dailyDoneMap === undefined && svc.setTabDailyDone === undefined);

  /* ── 5) 목록 응답 계약 ─────────────────────────────────────── */
  console.log('\n5) 목록 응답 계약 (/tabs)');
  const tabsLayer = router.stack.find(l => l.route && l.route.path === '/tabs');
  const tabsHandler = tabsLayer.route.stack[tabsLayer.route.stack.length - 1].handle;
  const oScoped = svc.scopedActiveTabs, oFin = svc.finishedTabsMap, oStats = svc.tabStatsMap;
  svc.scopedActiveTabs = async () => ([{ sheetId: 'S1', tabName: 'T1', tabGid: '1' }, { sheetId: 'S1', tabName: 'T2', tabGid: '2' }]);
  svc.finishedTabsMap = async () => ({ ok: true, map: {} });
  svc.tabStatsMap = async () => ({ ok: true, map: {} });
  const callTabs = async (admin, query) => {
    let payload = null;
    const res = { status() { return this; }, json(o) { payload = o; return this; } };
    await tabsHandler({ admin, query: query || {} }, res, e => { payload = { thrown: e && e.message }; });
    return payload;
  };
  const asAdmin = await callTabs({ role: 'admin', name: 'a' }, {});
  t('★ 목록 응답에 오늘 완료 주석·날짜·실패 깃발이 없다(제거 후 잔재 0)',
    asAdmin.tabs.every(x => x.todayDone === undefined) && asAdmin.kstDate === undefined && asAdmin.dailyUnavailable === undefined);
  svc.scopedActiveTabs = oScoped; svc.finishedTabsMap = oFin; svc.tabStatsMap = oStats;
  pool.query = origQuery;

  /* ── 6) 격리 ───────────────────────────────────────────────── */
  console.log('\n6) 격리');
  // ⚠ 종료 경계를 `module.exports` 로 두면 M2 구역 **아래에 붙은 다른 기능의 쿼리**까지 빨려 들어와
  //   이 검사가 조용히 빨개진다(2026-08-18 실측). 소스의 `// ══ /M2` 닫는 마커까지만 자른다.
  const m2Block = (SVC_SRC.match(/\/\/ ══ M2: 열린 작업 줄[\s\S]*?\/\/ ══ \/M2/m) || [''])[0];
  assert.ok(m2Block, 'M2 구역 마커(// ══ M2 … // ══ /M2)를 찾지 못했다 — 마커를 지우지 말 것');
  // `ON CONFLICT ... DO UPDATE SET` 은 같은 문장의 upsert 절이라 대상 테이블이 아니다 → 제외 후 판정
  const m2Writes = m2Block.replace(/--[^\n]*/g, '').replace(/DO UPDATE SET/gi, '');
  t('★ 쓰기 표면은 열린 작업 줄 표 하나뿐(운영 테이블 무접촉 — 오늘 완료 표 쓰기도 제거됨)',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(?!trackb_workdesk_worktabs)/i.test(m2Writes),
    (m2Writes.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+\w+/gi) || []).join(','));
  t('★ 시트 API 무접촉', !/sheets|spreadsheets|throttledCall/i.test(m2Block));

  /* ── 7) 프론트 배선 ────────────────────────────────────────── */
  console.log('\n7) 프론트 배선');
  t('작업보드 상단 순서는 업체 → 선택 업체 작업 드롭다운 → 열린 작업이다',
    /class="tb1 wb-tier wb-company"[\s\S]{0,1200}class="wb-task-menu" id="taskmenu" hidden[\s\S]{0,1200}class="tb0 wb-tier wb-open"/.test(WD));
  t('★ 작업을 여는 모든 경로가 selTab 으로 수렴 → 거기서 줄에 추가(사본 금지)',
    /_renderTabList\(\);[\s\S]{0,200}_wtOpen\(t\);/.test(WD) && (WD.match(/_wtOpen\(/g) || []).length === 2);
  t('★★ 열린 줄 변경은 단일 커밋 지점(_wtCommit) — 사본을 두면 dirty 를 안 세워 부팅 경합이 되살아난다',
    /function _wtCommit\(list\)\{[\s\S]{0,220}STATE\._wtDirty=true/.test(WD));
  t('★★ 부팅 조회가 늦게 와도 내 변경을 덮지 않는다(실측 사고 — 방금 연 탭이 사라졌다)',
    /if\(!STATE\._wtBootSynced && STATE\._wtDirty\)\{ STATE\._wtBootSynced=true; _wtPush\(\); return; \}/.test(WD));
  // ★★ dirty 를 영구 깃발로 쓰면 세션 중 탭을 한 번 연 뒤로 서버 값을 영영 안 받아, 다른 창·다른 PC 의
  //   변경이 한 방향으로만 지워진다("기기 무관 유지" 약속과 정면 충돌 — 코드리뷰 지적).
  t('★★ 부팅 가드는 1회 한정(_wtBootSynced) — dirty 영구화 금지', /STATE\._wtBootSynced=true;\s*\n\s*STATE\.worktabs=r\.tabs/.test(WD));
  t('★ 저장 성공 시 dirty 해제(서버와 같은 상태 → 다음 동기화를 받아들인다)',
    /if\(r&&r\.ok\)\{ STATE\._wtDirty=false; return; \}/.test(WD));
  // ★ 응답이 온 실패(ok:false)와 네트워크 예외(catch) **둘 다** 알려야 한다 — 한쪽만 보면
  //   다른 쪽을 지워도 가드가 통과한다(변이시험이 실제로 통과시켰다).
  t('★ 저장 실패를 조용히 삼키지 않는다 — 응답 실패 경로',
    /if\(r&&r\.ok\)\{ STATE\._wtDirty=false; return; \}[\s\S]{0,200}toast\(\(r&&r\.error\)\|\|'열린 작업 줄을 저장하지 못했습니다'\)/.test(WD));
  t('★ 저장 실패를 조용히 삼키지 않는다 — 네트워크 예외 경로',
    /catch\(_\)\{ if\(!STATE\._wtWarned\)\{ STATE\._wtWarned=true; toast\('열린 작업 줄을 저장하지 못했습니다'\); \} \}/.test(WD));
  t('★ 조회 실패 시 로컬을 유지하고 고지한다(서버 빈 배열로 로컬을 덮지 않는다)',
    /if\(r\.worktabsUnavailable\)\{ STATE\.worktabsUnavailable=true; _renderWorktabs\(\); return; \}/.test(WD)
    && /worktabsUnavailable[\s\S]{0,140}열린 작업 줄을 불러오지 못했습니다/.test(WD));
  t('★★ 계정 전환 시 열린 줄·즐겨찾기 메모리 상태를 비운다(키가 계정별이어도 메모리를 안 비우면 무의미 — 이전 계정 탭명 노출 + 그 목록이 새 계정 서버 행에 저장)',
    (WD.match(/worktabs:null,_wtLoaded:false,_wtDirty:false,_wtBootSynced:false/g) || []).length === 2
    && (WD.match(/favs:null,_favLoaded:false/g) || []).length === 2);
  t('★ 상한에서 **열기를 막는다**(서버가 뒤를 자르면 방금 연 탭만 사라져 이해 불가한 동작)',
    /if\(list\.length>=WT_CAP\)\{ toast\(/.test(WD));
  t('★ 드래그: 오른쪽으로 끌면 대상 뒤 — 끝자리로 옮길 수 있어야 한다(항상 앞이면 불가능)',
    /list\.splice\(a<b\?at\+1:at, 0, from\);/.test(WD));
  t('★ 렌더 함수는 서버에 쓰지 않는다(정리는 데이터 도착 지점 _wtPruneFinished)',
    /function _renderWorktabs\(\)\{[\s\S]{0,900}?\}\n/.test(WD)
    && !/function _renderWorktabs\(\)\{[\s\S]{0,1200}?_wtPush\(\)/.test(WD));
  t('★ 자동 정리는 dirty 를 세우지 않는다(시스템 정리를 사용자 편집으로 치면 구식 로컬이 서버를 이긴다)',
    /function _wtPruneFinished\(\)\{[\s\S]{0,600}STATE\.worktabs=alive; STATE\._wtLoaded=true; _wtSaveLocal\(\)/.test(WD)
    && !/function _wtPruneFinished\(\)\{[\s\S]{0,600}_wtDirty=true/.test(WD));
  t('★ 즐겨찾기 원장에 얹지 않는다(별도 엔드포인트 — Set 직렬화로 순서가 사라진다)',
    /api\('\/api\/trackb\/workdesk\/worktabs'/.test(WD) && !/@open␟/.test(WD));
  t('탭 키 규약은 즐겨찾기와 동일(_favKey 재사용 — 두 벌이면 같은 탭이 다른 키가 된다)',
    /function _wtIdxOf\(t\)\{ return _wtList\(\)\.indexOf\(_favKey\(t\)\); \}/.test(WD));
  // ★★ 정리 대상은 "목록에서 확인된 마감 탭"뿐. `t && !isFinished(t)` 로 거르면 목록에 없는 탭
  //   (아직 안 왔거나 limit 300 에 잘린 탭)까지 사라져 사용자의 열린 줄이 조용히 소실된다.
  t('★ 마감된 작업은 열린 줄에서 자동 정리(전사 공통이라 남이 마감해도 빠진다)',
    /const alive=list\.filter\(k=>\{ const t=_wtTabFor\(k\); return !\(t && isFinished\(t\)\); \}\);/.test(WD));
  t('★★ 목록에 없는 탭은 지우지 않는다(목록 미도착·상한 절단으로 열린 줄이 소실되는 사고 차단)',
    !/return t && !isFinished\(t\)/.test(WD));
  t('★★ 목록이 아직 안 왔을 때는 정리 자체를 안 한다(부팅 때 전부 지워지는 사고 방지)',
    /function _wtPruneFinished\(\)\{\s*\n\s*if\(!\(STATE\.tabs\|\|\[\]\)\.length\) return;/.test(WD));
  t('★ 오늘 완료 화면 잔재 0 — 체크 버튼·토글 함수·팀 진행률·정렬·날짜 자가치유',
    !/toggleTodayDone|isTodayDone|todayDone|_finDayRollCheck|STATE\.kstDate|dailyUnavailable|tab-daily-done/.test(WD)
    && !/오늘 완료 \$\{nToday\}/.test(WD));
  // ★★ M1 에서 실측한 따옴표 탈출 — 열린 줄도 같은 규율(문자열 보간 금지, data 속성 전달)
  t('★★ 0단 onclick 에 시트에서 온 이름을 넣지 않는다(따옴표 하나로 임의 JS 실행)',
    !/onclick="wt(Pick|Close)\('/.test(WD) && /onclick="wtPick\(this\.dataset\.k\)"/.test(WD));
  t('★ 닫기(×)에도 data-k 를 붙인다(부모에만 두면 this.dataset.k 가 undefined 라 닫기가 죽는다 — 실측)',
    /<span class="x" data-k="\$\{esc\(k\)\}"/.test(WD));
  t('광고주에겐 열린 줄을 그리지 않는다', /if\(STATE\.role==='advertiser'\)\{ host\.innerHTML=''; return; \}/.test(WD));
  t('상한 초과는 안내만(자동으로 닫지 않는다)', /now\.length>=WT_CAP\?`<span class="wt0note"/.test(WD));

  /* ── 8) 무결성 ─────────────────────────────────────────────── */
  console.log('\n8) CSS·스크립트 무결성');
  const styles = [...WD.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  let cssOk = true;
  styles.forEach(css => {
    const op = (css.match(/\/\*/g) || []).length, cl = (css.match(/\*\//g) || []).length;
    const st = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (op !== cl || (st.match(/{/g) || []).length !== (st.match(/}/g) || []).length) cssOk = false;
  });
  t('★ CSS 주석·중괄호 균형', cssOk);
  let jsOk = true, jsErr = '';
  [...WD.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach(m => {
    try { new Function(m[1]); } catch (e) { jsOk = false; jsErr = e.message; }
  });
  t('★ 인라인 스크립트 파싱', jsOk, jsErr);
  t('신설 클래스는 wt0 접두(기존 wtab·seg 계열과 충돌 금지)', /\.wt0\{/.test(WD) && !/^\s*\.wtab\{[^}]*border-radius:8px 8px 0 0/m.test(WD));

  console.log(`\n✅ ${pass} 케이스 통과\n`);
  process.exit(0);   // trackB.routes require 로 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구)
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
