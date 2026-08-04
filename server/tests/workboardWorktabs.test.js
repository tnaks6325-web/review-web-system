/**
 * workboardWorktabs.test.js — "열린 작업 줄"(개인별) + "오늘 완료"(전사 공통) 회귀가드 (M2)
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
 *  ⑤ **권한** — 오늘 완료도 전사 공통 쓰기다(staff 담당 탭만·광고주 차단). authMiddleware 선행 필수.
 *  ⑥ **CSS/스크립트 무결성** — 주석 조기 종료가 규칙을 통째로 삼키고 브라우저는 에러 없이 넘어간다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 열린 작업 줄 + 오늘 완료 회귀가드 (M2)\n');

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
const DD = L['POST /workdesk/tab-daily-done'];
t('POST /workdesk/tab-daily-done 등록', Array.isArray(DD));
t('★ authMiddleware 가 맨 앞(빠지면 마스터 포함 전원 403 — 레포 실측 사고)', DD[0] === 'authMiddleware', (DD || []).join(','));
t('★ 라우트레벨 adminOrMaster 없음 — staff 담당 탭 체크 경로 보존(스코프는 _ensureEditScope 가 건다)',
  !DD.includes('adminOrMasterMiddleware') && !DD.includes('masterOnlyMiddleware'));
t('오늘 완료 라우트가 _ensureEditScope 를 쓴다', /tab-daily-done[\s\S]{0,700}_ensureEditScope/.test(ROUTES));
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

  pool.query = async () => { throw new Error('relation "trackb_workdesk_worktabs" does not exist'); };
  t('★ 조회 실패 = 빈 줄(개인 화면 편의 기능이라 목록 전체를 죽이지 않는다)',
    JSON.stringify(await svc.getWorkdeskWorktabs('만두')) === '[]');

  // ── 오늘 완료 ──
  const cs = require('../src/services/campaignState.service');
  const today = cs.kstTodayStr();
  stub(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
  const on = await svc.setTabDailyDone({ sheetId: 'S1', tabName: 'T1', done: true, by: '만두' });
  t('오늘 완료 ON', on.ok === true && on.done === true && on.created === true);
  t('★ KST 오늘 날짜로 기록(서버 파생 — 클라이언트 시계 불신)', SQL[0].p.includes(today), JSON.stringify(SQL[0].p));
  t('★ 같은 날 중복은 멱등(ON CONFLICT DO NOTHING)',
    /ON CONFLICT \(sheet_id, tab_name, done_date\) DO NOTHING/.test(SQL[0].q));

  stub(() => ({ rows: [], rowCount: 0 }));
  const again = await svc.setTabDailyDone({ sheetId: 'S1', tabName: 'T1', done: true, by: '망고' });
  t('재체크는 실패가 아니라 멱등 성공(created:false)', again.ok === true && again.created === false);

  stub(() => ({ rows: [], rowCount: 1 }));
  const off = await svc.setTabDailyDone({ sheetId: 'S1', tabName: 'T1', done: false, by: '만두' });
  t('해제 = 오늘 행만 DELETE', off.ok === true && off.done === false && /DELETE FROM trackb_tab_daily_done/.test(SQL[0].q));
  t('★★ 해제가 **오늘 행만** 지운다(어제 이력을 지우면 "언제 처리했나"가 사라진다)',
    /done_date=\$3::date/.test(SQL[0].q) && SQL[0].p.includes(today));

  stub(() => ({ rows: [{ sheetId: 'S1', tabName: 'T1', doneBy: '만두' }] }));
  const dm = await svc.dailyDoneMap();
  t('오늘 완료 맵 + 성공 플래그', dm.ok === true && !!dm.map['S1\tT1'] && dm.date === today);
  t('★★ 조회가 "오늘"만 본다 — 어제 행은 저절로 빠진다(자정 리셋 크론이 없는 이유)',
    /WHERE done_date = \$1::date/.test(SQL[0].q) && SQL[0].p[0] === today);

  pool.query = async () => { const e = new Error('nope'); e.code = '42P01'; throw e; };
  const dfail = await svc.dailyDoneMap();
  t('★ 조회 실패는 ok:false 로 구분(빈 맵만 주면 체크가 조용히 풀린 것처럼 보인다)', dfail.ok === false);
  const nr = await svc.setTabDailyDone({ sheetId: 'S1', tabName: 'T1', done: true, by: '만두' });
  t('★ 마이그레이션 미적용(42P01)은 진단 가능한 메시지로', nr.ok === false && nr.code === 'not_ready' && /089/.test(nr.error));

  /* ── 4) 라우트 실행 — 스코프 · 파싱 ────────────────────────── */
  console.log('\n4) 스코프 · 파싱 (라우트 실제 호출)');
  const layer = router.stack.find(l => l.route && l.route.path === '/workdesk/tab-daily-done');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (admin, body) => {
    let status = 200, payload = null;
    const res = { status(c) { status = c; return this; }, json(o) { payload = o; return this; } };
    await handler({ admin, body, query: {} }, res, e => { payload = { thrown: e && e.message }; });
    return { status, payload };
  };
  const origSet = svc.setTabDailyDone, origCan = svc.canAccessTab;
  let calls = 0, lastArgs = null;
  svc.setTabDailyDone = async (a) => { calls++; lastArgs = a; return { ok: true }; };

  calls = 0;
  t('master 는 전체 탭 체크 가능', (await call({ role: 'master', name: 'm' }, { sheetId: 'S', tabName: 'T', done: true })).status === 200 && calls === 1);
  calls = 0; svc.canAccessTab = async () => false;
  const staffNo = await call({ role: 'staff', name: 'ae' }, { sheetId: 'S', tabName: 'T', done: true });
  t('★ staff 담당 밖 탭 = 403 + 서비스 미호출', staffNo.status === 403 && calls === 0);
  calls = 0; svc.canAccessTab = async () => true;
  t('staff 담당 탭은 체크 가능', (await call({ role: 'staff', name: 'ae' }, { sheetId: 'S', tabName: 'T', done: true })).status === 200 && calls === 1);
  calls = 0;
  t('★ 광고주는 차단(오늘 완료도 내부 업무)', (await call({ role: 'advertiser', advertiser_id: 'a' }, { sheetId: 'S', tabName: 'T' })).status === 403 && calls === 0);
  t('sheetId/tabName 없으면 400', (await call({ role: 'master', name: 'm' }, {})).status === 400);
  await call({ role: 'master', name: 'm' }, { sheetId: 'S', tabName: 'T', done: 'false' });
  t("★ done:'false'(문자열)를 완료로 오해하지 않는다(해제가 체크가 되면 되돌릴 수 없다)", lastArgs.done === false);
  await call({ role: 'master', name: 'm' }, { sheetId: 'S', tabName: 'T', done: true });
  t('done:true 는 완료', lastArgs.done === true);
  svc.setTabDailyDone = origSet; svc.canAccessTab = origCan;

  /* ── 5) 목록 응답 계약 ─────────────────────────────────────── */
  console.log('\n5) 목록 응답 계약 (/tabs)');
  const tabsLayer = router.stack.find(l => l.route && l.route.path === '/tabs');
  const tabsHandler = tabsLayer.route.stack[tabsLayer.route.stack.length - 1].handle;
  const oScoped = svc.scopedActiveTabs, oFin = svc.finishedTabsMap, oStats = svc.tabStatsMap, oDaily = svc.dailyDoneMap;
  svc.scopedActiveTabs = async () => ([{ sheetId: 'S1', tabName: 'T1', tabGid: '1' }, { sheetId: 'S1', tabName: 'T2', tabGid: '2' }]);
  svc.finishedTabsMap = async () => ({ ok: true, map: {} });
  svc.tabStatsMap = async () => ({ ok: true, map: {} });
  svc.dailyDoneMap = async () => ({ ok: true, map: { 'S1\tT2': { doneBy: '만두' } }, date: today });
  const callTabs = async (admin, query) => {
    let payload = null;
    const res = { status() { return this; }, json(o) { payload = o; return this; } };
    await tabsHandler({ admin, query: query || {} }, res, e => { payload = { thrown: e && e.message }; });
    return payload;
  };
  const asAdmin = await callTabs({ role: 'admin', name: 'a' }, {});
  t('오늘 완료를 주석으로 동봉', asAdmin.tabs[1].todayDone === true && asAdmin.tabs[0].todayDone === undefined);
  t('오늘 기준 날짜를 함께 준다(화면이 서버 시각을 따르게)', asAdmin.kstDate === today);
  svc.dailyDoneMap = async () => ({ ok: false, map: {}, date: today });
  t('★ 조회 실패를 응답에 고지(dailyUnavailable) — 없으면 프론트가 체크를 지운다',
    (await callTabs({ role: 'admin', name: 'a' }, {})).dailyUnavailable === true);
  svc.dailyDoneMap = async () => ({ ok: true, map: { 'S1\tT2': { doneBy: '만두' } }, date: today });
  const asAdv = await callTabs({ role: 'advertiser', advertiser_id: 'a1' }, {});
  t('★ 광고주 응답엔 오늘 완료 주석이 없다(내부 업무 신호)', asAdv.tabs.every(x => x.todayDone === undefined));
  svc.scopedActiveTabs = oScoped; svc.finishedTabsMap = oFin; svc.tabStatsMap = oStats; svc.dailyDoneMap = oDaily;
  pool.query = origQuery;

  /* ── 6) 격리 ───────────────────────────────────────────────── */
  console.log('\n6) 격리');
  const m2Block = (SVC_SRC.match(/\/\/ ══ M2: 열린 작업 줄[\s\S]*?^module\.exports/m) || [''])[0];
  // `ON CONFLICT ... DO UPDATE SET` 은 같은 문장의 upsert 절이라 대상 테이블이 아니다 → 제외 후 판정
  const m2Writes = m2Block.replace(/--[^\n]*/g, '').replace(/DO UPDATE SET/gi, '');
  t('★ 쓰기 표면은 신규 2테이블뿐(운영 테이블 무접촉)',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(?!trackb_workdesk_worktabs|trackb_tab_daily_done)/i.test(m2Writes),
    (m2Writes.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+\w+/gi) || []).join(','));
  t('★ 시트 API 무접촉', !/sheets|spreadsheets|throttledCall/i.test(m2Block));
  t('★★ KST 파생은 campaignState.kstTodayStr 재사용(사본을 만들면 날짜 규칙이 두 벌이 되어 갈린다)',
    /require\('\.\/campaignState\.service'\)\.kstTodayStr\(\)/.test(m2Block) && !/KST_OFFSET/.test(m2Block));

  /* ── 7) 프론트 배선 ────────────────────────────────────────── */
  console.log('\n7) 프론트 배선');
  t('0단 열린 작업 줄이 1·2단 위에 있다', /<div class="tb0" id="tb0"><\/div>[\s\S]{0,80}<div class="tb1">/.test(WD));
  t('★ 작업을 여는 모든 경로가 selTab 으로 수렴 → 거기서 줄에 추가(사본 금지)',
    /_renderTabList\(\);[\s\S]{0,200}_wtOpen\(t\);/.test(WD) && (WD.match(/_wtOpen\(/g) || []).length === 2);
  t('★★ 열린 줄 변경은 단일 커밋 지점(_wtCommit) — 사본을 두면 dirty 를 안 세워 부팅 경합이 되살아난다',
    /function _wtCommit\(list\)\{[\s\S]{0,220}STATE\._wtDirty=true/.test(WD));
  t('★★ 부팅 조회가 늦게 와도 내 변경을 덮지 않는다(실측 사고 — 방금 연 탭이 사라졌다)',
    /if\(STATE\._wtDirty\)\{ _wtPush\(\); return; \}/.test(WD));
  t('★ 즐겨찾기 원장에 얹지 않는다(별도 엔드포인트 — Set 직렬화로 순서가 사라진다)',
    /api\('\/api\/trackb\/workdesk\/worktabs'/.test(WD) && !/@open␟/.test(WD));
  t('탭 키 규약은 즐겨찾기와 동일(_favKey 재사용 — 두 벌이면 같은 탭이 다른 키가 된다)',
    /function _wtIdxOf\(t\)\{ return _wtList\(\)\.indexOf\(_favKey\(t\)\); \}/.test(WD));
  t('★ 마감된 작업은 열린 줄에서 자동 정리(전사 공통이라 남이 마감해도 빠진다)',
    /const alive=list\.filter\(k=>\{ const t=_wtTabFor\(k\); return t && !isFinished\(t\); \}\);/.test(WD));
  t('★★ 목록이 아직 안 왔을 때는 정리하지 않는다(부팅 때 전부 지워지는 사고 방지)',
    /if\(\(STATE\.tabs\|\|\[\]\)\.length\)\{[\s\S]{0,200}alive/.test(WD));
  t('★ 오늘 완료한 탭은 줄 **뒤로** 민다(시트에서 탭 뒤로 끌던 동작)',
    /\.\.\.known\.filter\(x=>!isTodayDone\(x\.t\)\), \.\.\.known\.filter\(x=>isTodayDone\(x\.t\)\)/.test(WD));
  t('★★ 오늘 완료는 목록에서 사라지지 않는다(사라지는 건 마감뿐) — 정렬만 뒤로',
    /else \{ const n=list\.filter\(t=>!isTodayDone\(t\)\), d=list\.filter\(t=>isTodayDone\(t\)\); list=\[\.\.\.n,\.\.\.d\]; \}/.test(WD));
  t('★ 홈에 "오늘 완료 n / m" 팀 진행률', /오늘 완료 \$\{nToday\} \/ \$\{nRun\}/.test(WD));
  t('토글 실패 시 낙관적 반영을 되돌린다(화면만 바뀐 채 두지 않는다)',
    /t\.todayDone=!want; _finRenderList\(\)/.test(WD));
  t('★ 조회 실패 응답으로 오늘 완료 체크를 지우지 않는다',
    /if\(!r\.dailyUnavailable\)\{ t\.todayDone=!!n\.todayDone/.test(WD));
  t('실패를 화면이 말한다', /dailyUnavailable[\s\S]{0,120}오늘 완료 표시를 불러오지 못했습니다/.test(WD));
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
