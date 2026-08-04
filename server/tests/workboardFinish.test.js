/**
 * workboardFinish.test.js — 작업보드 "마감"(전사 공통) + 홈 작업 목록 회귀가드 (M1)
 * 실행: node tests/workboardFinish.test.js
 * 설계: frontend/docs/prd-workboard-worktabs.html (v1.2, 사용자 확정) · migration 088
 *
 * 이 변경에서 깨지면 아픈 것 여섯.
 *  ① **검수 게이트** — 마감 확정에는 "리뷰폴더 마감자료 검수"의 사람 확인이 필수(사용자 확정 ㉠).
 *     프론트 체크만 믿으면 확인창을 우회한 요청이 그대로 통과한다 → 서비스를 **실제 실행**해 고정한다.
 *     ★ 거부될 때 **DB 를 건드리지 않는 것**까지 본다(거부인데 행이 생기면 게이트가 무의미).
 *  ② **권한** — 레포가 이미 밟은 함정: 역할 미들웨어 앞에 authMiddleware 를 빠뜨리면 전원 403.
 *     그리고 staff(AE)는 담당 탭만, advertiser 는 차단 → 라우트를 **실제 호출**해 확인한다.
 *  ③ **보관함 보호** — 서버가 목록에서 마감 탭을 걸러 버리면 "마감 보관함"이 영원히 빈다.
 *     서버는 **주석만** 달고 거르는 것은 프론트라는 계약을 고정한다.
 *  ④ **Track A 무접촉** — 마감은 화면 분류일 뿐이다. tab_configs.is_closed(기존 소비처가 동작을 바꾼다)나
 *     시트 쓰기에 손대면 "되돌리기 클릭 한 번"이라는 계약이 깨진다.
 *  ⑤ **숫자 단일 writer** — 히어로 "진행 중 작업"과 목록 [진행 중]이 다른 곳에서 계산되면 마감 직후
 *     3 과 2 로 갈린다(브라우저 검증이 실제로 잡은 회귀).
 *  ⑥ **CSS/스크립트 무결성** — 주석 조기 종료가 규칙을 통째로 삼키고 브라우저는 에러 없이 넘어간다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 작업보드 마감 + 홈 작업 목록 회귀가드 (M1)\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const ROUTES = S('src/routes/trackB.routes.js');
const SVC_SRC = S('src/services/trackB.service.js');
const MIG = S('migrations/088_trackb_tab_finished.sql');

/* ── 1) 마이그레이션 ─────────────────────────────────────────── */
console.log('1) migration 088');
t('IF NOT EXISTS(재실행 idempotent — 러너가 매 부팅 전 파일을 다시 돌린다)',
  /CREATE TABLE IF NOT EXISTS trackb_tab_finished/.test(MIG));
t('활성 마감은 탭당 1건(부분 유니크) = 코드 실수로도 중복 마감 불가',
  /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*?trackb_tab_finished \(sheet_id, tab_name\) WHERE deleted_at IS NULL/.test(MIG));
t('복귀는 소프트 삭제(deleted_at) = 이력 보존', /deleted_at\s+TIMESTAMPTZ/.test(MIG));
t('검수 확인 시각을 박제(inspect_confirmed_at) — 책임추적', /inspect_confirmed_at\s+TIMESTAMPTZ/.test(MIG));
t('되돌리기 방법이 주석에 있다(레포 관용구)', /되돌리기/.test(MIG));
// ★ FK 타입 사고(082 의 42804 = 파일 전체 롤백) 계열 차단: 이 파일은 FK 를 만들지 않는다
t('FK 미사용(참조 타입 불일치로 파일 전체가 롤백되는 계열 사고 원천 차단)', !/REFERENCES/i.test(MIG));

/* ── 2) 권한 — 라우터 스택 실검사 ─────────────────────────────── */
console.log('\n2) 권한 (라우터 스택 실검사)');
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});
const FIN = L['POST /workdesk/tab-finish'];
t('POST /workdesk/tab-finish 등록됨', Array.isArray(FIN), JSON.stringify(Object.keys(L).slice(0, 5)));
t('★ authMiddleware 가 맨 앞(빠지면 마스터 포함 전원 403 — 레포 실측 사고)', FIN[0] === 'authMiddleware', FIN.join(','));
// staff(AE)도 담당 탭은 마감할 수 있어야 하므로 라우트레벨 adminOrMaster 를 걸면 안 된다(사용자 확정 ㉣).
t('★ 라우트레벨 adminOrMaster 없음 — staff 담당 탭 마감 경로 보존(스코프는 _ensureEditScope 가 건다)',
  !FIN.includes('adminOrMasterMiddleware') && !FIN.includes('masterOnlyMiddleware'), FIN.join(','));
t('GET /tabs 생존(작업목록·홈의 유일한 출처)', Array.isArray(L['GET /tabs']));
t('마감 라우트가 _ensureEditScope 를 쓴다(master/admin 전체 · staff 담당 · advertiser 차단)',
  /tab-finish[\s\S]{0,700}_ensureEditScope/.test(ROUTES));

/* ── 3) 검수 게이트 + 멱등 — 서비스 실제 실행(스텁 pool) ────────── */
console.log('\n3) 검수 게이트 · 멱등 (서비스 실행)');
const pool = require('../src/db/pool');
const svc = require('../src/services/trackB.service');
const origQuery = pool.query.bind(pool);
let SQL = [];
const stub = (impl) => { SQL = []; pool.query = async (q, p) => { SQL.push({ q: String(q), p }); return impl ? impl(String(q), p) : { rows: [], rowCount: 0 }; }; };

(async () => {
  // ①-a 검수 확인 없이 마감 → 거부 + DB 무접촉
  stub();
  const denied = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', finish: true, inspected: false, by: '만두' });
  t('★ 검수 확인 없는 마감은 거부(서버 최종 방어 — 확인창 우회 차단)', denied.ok === false && denied.code === 'inspect_required');
  t('★ 거부 시 DB 쿼리 0건(거부인데 행이 생기면 게이트가 무의미)', SQL.length === 0, JSON.stringify(SQL.map(s => s.q.slice(0, 40))));

  // ①-b 검수 확인 후 마감 → INSERT, 부분 유니크로 중복 불가
  stub(() => ({ rows: [{ id: 1, finishedAt: '2026-08-04T00:00:00Z' }], rowCount: 1 }));
  const done = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', tabGid: '9', finish: true, inspected: true, by: '만두' });
  t('검수 확인 후 마감 성공', done.ok === true && done.finished === true && done.created === true);
  t('INSERT 에 검수 확인 시각 기록(inspect_confirmed_at)', /inspect_confirmed_at/.test(SQL[0].q));
  t('★ ON CONFLICT 가 부분 유니크(WHERE deleted_at IS NULL)를 지목 — 재마감이 중복 행을 만들지 않는다',
    /ON CONFLICT \(sheet_id, tab_name\) WHERE deleted_at IS NULL DO NOTHING/.test(SQL[0].q));
  t('마감자를 기록(finished_by)', SQL[0].p.includes('만두'));

  // ①-c 재마감(멱등) — RETURNING 이 비면 created:false, 실패가 아니다
  stub(() => ({ rows: [], rowCount: 0 }));
  const again = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', finish: true, inspected: true, by: '망고' });
  t('재마감은 실패가 아니라 멱등 성공(created:false)', again.ok === true && again.created === false);

  // ①-d 복귀 = 소프트 삭제
  stub(() => ({ rows: [], rowCount: 1 }));
  const back = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', finish: false, by: '만두' });
  t('복귀는 소프트 삭제 + 복귀자 기록', back.ok === true && back.finished === false
    && /SET deleted_at=NOW\(\), reopened_by/.test(SQL[0].q));
  t('★ 복귀에는 검수 확인이 필요 없다(되돌리기는 마찰이 낮아야 한다)', back.reopened === 1);

  // ② fail-soft — 테이블 부재/조회 실패가 목록 전체를 죽이면 안 된다
  pool.query = async () => { throw new Error('relation "trackb_tab_finished" does not exist'); };
  t('★ 마감 조회 실패 = 빈 맵(= 아무것도 마감 안 됨 = 오늘과 같은 화면). 목록이 죽지 않는다',
    JSON.stringify(await svc.finishedTabsMap()) === '{}');
  t('★ 통계 조회 실패 = 빈 맵(표에 "—" 만 뜨고 목록은 그대로)',
    JSON.stringify(await svc.tabStatsMap({ force: true })) === '{}');

  /* ── 4) 라우트 실행 — 스코프 ───────────────────────────────── */
  console.log('\n4) 스코프 (라우트 실제 호출)');
  const layer = router.stack.find(l => l.route && l.route.path === '/workdesk/tab-finish');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (admin, body) => {
    let status = 200, payload = null;
    const res = { status(c) { status = c; return this; }, json(o) { payload = o; return this; } };
    await handler({ admin, body, query: {} }, res, e => { payload = { thrown: e && e.message }; });
    return { status, payload };
  };
  let svcCalls = 0;
  const origSet = svc.setTabFinished;
  svc.setTabFinished = async (...a) => { svcCalls++; return { ok: true }; };
  const origCan = svc.canAccessTab;

  svcCalls = 0;
  const rMaster = await call({ role: 'master', name: 'm' }, { sheetId: 'S1', tabName: 'T1', finish: true, inspected: true });
  t('master 는 전체 탭 마감 가능', rMaster.status === 200 && svcCalls === 1);

  svcCalls = 0;
  svc.canAccessTab = async () => false;
  const rStaffNo = await call({ role: 'staff', name: 'ae1' }, { sheetId: 'S1', tabName: 'T1', finish: true, inspected: true });
  t('★ staff 담당 밖 탭 = 403', rStaffNo.status === 403);
  t('★ 거부 시 서비스 미호출(스코프 밖인데 상태가 바뀌면 안 된다)', svcCalls === 0);

  svcCalls = 0;
  svc.canAccessTab = async () => true;
  const rStaffOk = await call({ role: 'staff', name: 'ae1' }, { sheetId: 'S1', tabName: 'T1', finish: true, inspected: true });
  t('staff 담당 탭은 마감 가능(사용자 확정 ㉣)', rStaffOk.status === 200 && svcCalls === 1);

  svcCalls = 0;
  const rAdv = await call({ role: 'advertiser', advertiser_id: 'a1' }, { sheetId: 'S1', tabName: 'T1', finish: true, inspected: true });
  t('★ 광고주는 차단(마감은 내부 업무)', rAdv.status === 403 && svcCalls === 0);

  const rNoArgs = await call({ role: 'master', name: 'm' }, {});
  t('sheetId/tabName 없으면 400(형식 선검사 — Express 4 는 async rejection 을 안 잡는다)', rNoArgs.status === 400);

  svc.setTabFinished = origSet; svc.canAccessTab = origCan;

  /* ── 5) 목록 응답 계약 ─────────────────────────────────────── */
  console.log('\n5) 목록 응답 계약 (/tabs)');
  const tabsLayer = router.stack.find(l => l.route && l.route.path === '/tabs');
  const tabsHandler = tabsLayer.route.stack[tabsLayer.route.stack.length - 1].handle;
  const origScoped = svc.scopedActiveTabs, origFin = svc.finishedTabsMap, origStats = svc.tabStatsMap;
  const FAKE = () => ([
    { sheetId: 'S1', tabName: 'T1', tabGid: '1' },
    { sheetId: 'S1', tabName: 'T2', tabGid: '2' },
  ]);
  svc.scopedActiveTabs = async () => FAKE();
  svc.finishedTabsMap = async () => ({ 'S1\tT2': { finishedAt: 'X', finishedBy: '만두' } });
  let statsCalls = 0;
  svc.tabStatsMap = async () => { statsCalls++; return { 'S1\tT1': { manager: '만두', total: 10, submitted: 3, paid: 1 } }; };

  const callTabs = async (admin, query) => {
    let payload = null;
    const res = { status() { return this; }, json(o) { payload = o; return this; } };
    await tabsHandler({ admin, query: query || {} }, res, e => { payload = { thrown: e && e.message }; });
    return payload;
  };

  const asAdmin = await callTabs({ role: 'admin', name: 'a' }, {});
  t('★ 서버는 마감 탭을 거르지 않는다 — 주석만 단다(거르면 "마감 보관함"이 영원히 빈다)',
    asAdmin.tabs.length === 2 && asAdmin.tabs[1].finished === true && asAdmin.tabs[0].finished === undefined);
  t('마감자·마감시각 동봉(보관함 표기 재료)', asAdmin.tabs[1].finishedBy === '만두');
  t('stats 미요청 시 무거운 집계를 돌리지 않는다(탭 전환마다 도는 것 방지)', statsCalls === 0 && !asAdmin.tabs[0].stats);

  statsCalls = 0;
  const withStats = await callTabs({ role: 'admin', name: 'a' }, { stats: '1' });
  t('stats=1 이면 담당자·인원/제출/입금 동봉(홈 작업 목록 재료)',
    statsCalls === 1 && withStats.tabs[0].stats && withStats.tabs[0].stats.manager === '만두');

  statsCalls = 0;
  const asAdv = await callTabs({ role: 'advertiser', advertiser_id: 'a1' }, { stats: '1' });
  t('★ 광고주 응답엔 마감 주석·통계가 없다(마감자·담당자는 내부 정보 — 데이터 최소화)',
    asAdv.tabs.every(x => x.finished === undefined && !x.stats) && statsCalls === 0);

  svc.scopedActiveTabs = origScoped; svc.finishedTabsMap = origFin; svc.tabStatsMap = origStats;
  pool.query = origQuery;

  /* ── 6) Track A 무접촉 ─────────────────────────────────────── */
  console.log('\n6) Track A 무접촉 (격리)');
  const finBlock = (SVC_SRC.match(/const _FIN_KEY[\s\S]*?^module\.exports/m) || [''])[0];
  t('★ 쓰기 표면은 trackb_tab_finished 하나뿐(운영 테이블 무접촉)',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(?!trackb_tab_finished)/i.test(finBlock.replace(/--[^\n]*/g, '')),
    (finBlock.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+\w+/gi) || []).join(','));
  t('★ tab_configs.is_closed 를 재사용하지 않는다(그 플래그는 기존 소비처 동작을 바꾼다)',
    !/is_closed/.test(finBlock));
  t('★ 시트 API 무접촉(마감은 화면 분류일 뿐)', !/sheets|spreadsheets|throttledCall/i.test(finBlock));
  t('통계는 읽기 전용(SELECT 만)', /FROM tab_configs tc/.test(finBlock) && !/UPDATE tab_configs/.test(finBlock));
  t('마감자료 표시는 기존 정산 원장 재사용(신규 저장소 0)', /trackb_tab_closeouts/.test(finBlock));
  t('★ LATERAL LIMIT 1 — 마감자료가 여러 건이어도 행 곱증식 없음', /LATERAL[\s\S]{0,220}LIMIT 1/.test(finBlock));

  /* ── 7) 프론트 배선 ────────────────────────────────────────── */
  console.log('\n7) 프론트 배선 (workdesk.html)');
  t('★ 작업보드 1·2단에서 마감 탭 제외(= "작업보드에는 진행 중만")',
    /_wGroups\(\)\{[\s\S]{0,600}?if\(isFinished\(t\)\) return;/.test(WD));
  t('마감 후보 = 인원 충족 + 전건 제출 + 전건 입금(사용자 확정 ㉠)',
    /isFinishCandidate[\s\S]{0,260}s\.submitted\|0\)>=s\.total && \(s\.paid\|0\)>=s\.total/.test(WD));
  t('★ 통계 없으면 후보로 판정하지 않는다(모르면 제안하지 않는다)',
    /isFinishCandidate\(t\)\{[\s\S]{0,140}if\(!s\|\|!s\.total\) return false/.test(WD));
  t('마감 요청에 inspected:true 동봉', /tab-finish[\s\S]{0,320}inspected:true/.test(WD));
  t('★ 체크 전에는 [마감] 비활성 + 클릭해도 나가지 않는다(이중 방어)',
    /id="finGo" disabled/.test(WD) && /doFinish\(\)\{[\s\S]{0,200}if\(!chk\|\|!chk\.checked\) return;/.test(WD));
  t('★ 확인창은 body 직속(뷰 스크롤 컨테이너에 넣으면 오버레이가 화면 흐름에 섞인다 — 레포 실측 사고)',
    /document\.body\.appendChild\(ov\)/.test(WD));
  t('마감자료 미생성은 경고만(하드블록 금지 — 안 쓰는 작업 유형까지 막지 않는다)',
    /wbl-warn[\s\S]{0,200}마감자료가 아직/.test(WD) && !/closeoutDate[\s\S]{0,120}disabled=true/.test(WD));
  t('★ 히어로 "진행 중 작업" writer 는 한 곳(두 곳에서 세면 마감 직후 3 과 2 로 갈린다)',
    (WD.match(/getElementById\('hmStTabs'\)/g) || []).length === 1);
  t('★ 그 한 곳이 목록 렌더 안 = 목록 [진행 중] 개수와 같은 재료',
    /_finRenderList\(\)\{[\s\S]{0,900}getElementById\('hmStTabs'\)/.test(WD));
  t('홈 작업 목록이 히어로 바로 아래(사용자 확정 ㉢)',
    /class="hm-hero"[\s\S]{0,1400}<div id="wblMount"><\/div>[\s\S]{0,120}<div class="hm-wrap">/.test(WD));
  t('목록 → 작업 열기는 기존 pendingTab 계약 재사용(히스토리 규칙과 자동 정합)',
    /openTaskFromHome\(i\)\{[\s\S]{0,320}STATE\.pendingTab=[\s\S]{0,200}switchView\('workdesk'\)/.test(WD));
  t('★ 검색은 마감 작업도 찾아주되 마감이라고 말한다(작업바에서 빠진 작업을 되찾는 유일한 길)',
    /isFinished\(t\)\?'🏁 마감 · ':''/.test(WD));
  // ★★ 실측 취약점(이 작업에서 브라우저로 재현): onclick 에 시트에서 온 이름을 넣으면 esc() 로도 못 막는다.
  //   HTML 속성은 엔티티 디코드 후 JS 로 파싱되므로 탭명 `x'),alert(1),String('` 하나로 임의 JS 가 실행되고
  //   서버엔 잘린 탭명이 전송됐다. 레포 관용구 = **인덱스만 넘긴다**(worktable 후보 클릭·_idAttr 전례).
  t('★★ 마감/복귀 onclick 에 sheetId·tabName 문자열을 넣지 않는다(따옴표 탈출 = 임의 JS 실행)',
    !/onclick="[^"]*(openFinishModal|doReopen)\('/.test(WD),
    (WD.match(/onclick="[^"]*(openFinishModal|doReopen)\([^)]*\)/g) || []).join(' | '));
  t('★★ 인덱스 시그니처(문자열 인자를 되살리면 그 자리에서 깨진다)',
    /function openFinishModal\(i\)\{ const t=\(STATE\.tabs\|\|\[\]\)\[i\]/.test(WD)
    && /function doReopen\(i\)\{ const t=\(STATE\.tabs\|\|\[\]\)\[i\]/.test(WD));
  t('작업보드 헤더 바는 인자 없는 전용 진입점(STATE.cur 사용 — 문자열 보간 0)',
    /onclick="openFinishCur\(\)"/.test(WD) && /onclick="doReopenCur\(\)"/.test(WD));
  t('마감/복귀 버튼은 내부인만(_finCanEdit — 서버 게이트와 1:1)',
    /_finCanEdit\(\)\{ return STATE\.role==='master'\|\|STATE\.role==='admin'\|\|STATE\.role==='staff'; \}/.test(WD));
  t('작업바 로드는 stats 를 붙이지 않는다(무거운 집계를 탭 전환마다 돌리지 않는다)',
    /loadTabs\(\)\{[\s\S]{0,200}api\('\/api\/trackb\/tabs\?limit=300'\)/.test(WD));
  t('★ 통계는 배열 교체가 아니라 병합(인덱스=selTab 계약·STATE.cur 동일성 보존)',
    /_finEnsureStats[\s\S]{0,900}STATE\.tabs\.forEach\(t=>\{ const n=by\[/.test(WD));

  /* ── 8) 무결성 — 주석 조기 종료 / 스크립트 파싱 ──────────────── */
  console.log('\n8) CSS·스크립트 무결성');
  const styles = [...WD.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  let cssOk = true;
  styles.forEach(css => {
    const op = (css.match(/\/\*/g) || []).length, cl = (css.match(/\*\//g) || []).length;
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const ob = (stripped.match(/{/g) || []).length, cb = (stripped.match(/}/g) || []).length;
    if (op !== cl || ob !== cb) cssOk = false;
  });
  t('★ CSS 주석·중괄호 균형(주석 조기 종료는 규칙을 통째로 삼키고 브라우저는 에러 없이 넘어간다)', cssOk);
  const scripts = [...WD.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let jsOk = true, jsErr = '';
  scripts.forEach(s => { try { new Function(s); } catch (e) { jsOk = false; jsErr = e.message; } });
  t('★ 인라인 스크립트 파싱(별표+빗금 조합이 주석을 조기 종료시키면 화면 전체가 죽는다)', jsOk, jsErr);
  t('신설 클래스는 wbl- 접두(기존 hm- 계열·worow 류와 충돌 금지 — 레포 실측 사고 전례)',
    !/class="(worow|wodetail|wochip|lgtable)"/.test((WD.match(/<div class="wbl-box"[\s\S]{0,2000}/) || [''])[0]));

  console.log(`\n✅ ${pass} 케이스 통과\n`);
  process.exit(0);   // trackB.routes require 로 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구)
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
