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

  // ①-e 탭 리네임 대비 — 이름이 바뀌어도 gid 로 마감을 다시 찾는다(레포 규율: gid 우선 재매칭)
  stub(() => ({ rows: [{ sheetId: 'S1', tabName: '옛이름', tabGid: '77', finishedAt: 'X', finishedBy: '만두' }], rowCount: 1 }));
  const fmap = await svc.finishedTabsMap();
  t('★ 마감 맵에 gid 키도 함께 실린다(운영 중 탭 리네임으로 마감이 조용히 풀리는 것 방지)',
    fmap.ok === true && !!fmap.map['S1\t옛이름'] && !!fmap.map['S1\tgid:77']);
  stub(() => ({ rows: [{ sheetId: 'S1', tabName: 'T', tabGid: '', finishedAt: 'X', finishedBy: '만두' }], rowCount: 1 }));
  t('★ gid 가 비면 gid 키를 만들지 않는다(빈 값이 전부 매칭되는 사고 방지)',
    Object.keys((await svc.finishedTabsMap()).map).every(k => !/\tgid:$/.test(k)));

  // ② fail-soft — 목록 전체를 죽이지 않되, **실패했다는 사실은 반드시 알린다**
  pool.query = async () => { const e = new Error('relation "trackb_tab_finished" does not exist'); e.code = '42P01'; throw e; };
  const finFail = await svc.finishedTabsMap();
  t('★ 마감 조회 실패해도 목록은 죽지 않는다(빈 맵)', JSON.stringify(finFail.map) === '{}');
  t('★★ 실패를 ok:false 로 **구분해 돌려준다** — 빈 맵만 주면 호출부가 "아무것도 마감 안 됨"으로 읽어 마감 작업이 전부 보드로 되살아나고 보관함이 빈다(무신호)',
    finFail.ok === false);
  const stFail = await svc.tabStatsMap({ force: true });
  t('★ 통계 조회 실패도 같은 계약(빈 맵 + ok:false)', JSON.stringify(stFail.map) === '{}' && stFail.ok === false);
  // ★ 쓰기 경로는 fail-soft 가 아니다 — 다만 42P01 은 진단 가능한 문구로(마스킹된 200 방지)
  const notReady = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', finish: true, inspected: true, by: '만두' });
  t('★ 마이그레이션 미적용(42P01)은 진단 가능한 메시지로 반환(읽기는 정상처럼 보이므로 이 경로가 유일한 신호)',
    notReady.ok === false && notReady.code === 'not_ready' && /088/.test(notReady.error));

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
  svc.finishedTabsMap = async () => ({ ok: true, map: { 'S1\tT2': { finishedAt: 'X', finishedBy: '만두' } } });
  let statsCalls = 0;
  svc.tabStatsMap = async () => { statsCalls++; return { ok: true, map: { 'S1\tT1': { manager: '만두', total: 10, submitted: 3, paid: 1 } } }; };

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

  // 리네임 대비 gid 폴백이 라우트에서도 실제로 쓰인다
  svc.finishedTabsMap = async () => ({ ok: true, map: { 'S1\tgid:2': { finishedAt: 'X', finishedBy: '만두' } } });
  const byGid = await callTabs({ role: 'admin', name: 'a' }, {});
  t('★ 이름이 바뀐 탭도 gid 로 마감을 되찾는다(이름만 보면 마감이 조용히 풀린다)',
    byGid.tabs[1].finished === true && byGid.tabs[0].finished === undefined);

  // ★★ 조회 실패를 응답에 실어야 프론트가 기존 마감 표시를 덮지 않는다
  svc.finishedTabsMap = async () => ({ ok: false, map: {} });
  svc.tabStatsMap = async () => ({ ok: false, map: {} });
  const unavail = await callTabs({ role: 'admin', name: 'a' }, { stats: '1' });
  t('★★ 마감 조회 실패를 응답에 고지(finishedUnavailable) — 없으면 프론트가 전 작업을 진행 중으로 되살린다',
    unavail.finishedUnavailable === true);
  t('★ 통계 조회 실패도 고지(statsUnavailable)', unavail.statsUnavailable === true);
  svc.finishedTabsMap = async () => ({ ok: true, map: {} });
  svc.tabStatsMap = async () => ({ ok: true, map: {} });
  const healthy = await callTabs({ role: 'admin', name: 'a' }, { stats: '1' });
  t('정상일 때는 실패 플래그를 달지 않는다(구버전 백엔드와 구분되게 필드 자체가 없음)',
    healthy.finishedUnavailable === undefined && healthy.statsUnavailable === undefined);

  // ★ 목록 잘림 고지 — 마감 탭도 limit 을 차지하므로 마감이 쌓이면 진행 중 작업이 조용히 밀려난다
  svc.scopedActiveTabs = async () => Array.from({ length: 2 }, (_, i) => ({ sheetId: 'S', tabName: 'T' + i, tabGid: String(i) }));
  const trunc = await callTabs({ role: 'admin', name: 'a' }, { limit: '2' });
  t('★ 목록이 상한에 닿으면 truncated 로 알린다(잘림을 숨기면 "작업이 적은 것"과 구분되지 않는다)',
    trunc.truncated === true);
  const notTrunc = await callTabs({ role: 'admin', name: 'a' }, { limit: '50' });
  t('상한에 안 닿으면 truncated:false', notTrunc.truncated === false);

  svc.scopedActiveTabs = origScoped; svc.finishedTabsMap = origFin; svc.tabStatsMap = origStats;
  pool.query = origQuery;

  /* ── 5b) 복귀 라우트 파싱 ─────────────────────────────────── */
  const origSet2 = svc.setTabFinished;
  let lastArgs = null;
  svc.setTabFinished = async (a) => { lastArgs = a; return { ok: true }; };
  await call({ role: 'master', name: 'm' }, { sheetId: 'S', tabName: 'T', finish: 'false' });
  t("★ finish:'false'(문자열)를 마감으로 오해하지 않는다 — 복귀 요청이 마감이 되면 되돌리기가 불가능해진다",
    lastArgs.finish === false);
  await call({ role: 'master', name: 'm' }, { sheetId: 'S', tabName: 'T', finish: 0 });
  t('finish:0 도 복귀로 해석', lastArgs.finish === false);
  await call({ role: 'master', name: 'm' }, { sheetId: 'S', tabName: 'T', finish: true, inspected: true });
  t('finish:true 는 마감', lastArgs.finish === true);
  svc.setTabFinished = origSet2;

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
  t('★ 입금 집계는 WHERE 로 대상을 줄인다(홈 진입마다 review_index 전 행을 훑지 않는다)',
    /FROM review_index WHERE is_submitted2 = 'PAID' GROUP BY/.test(finBlock));
  t('마감/복귀는 감사 로그를 남긴다(같은 파일의 다른 전사 공통 쓰기와 같은 관례)',
    /logger\.info\(`\[trackB\] 작업 마감/.test(finBlock) && /logger\.info\(`\[trackB\] 작업 진행중 복귀/.test(finBlock));
  // ★★ 이 맵은 전 탭 무스코프 — 응답에 통째로 실으면 전 업체 담당자·캠페인명이 staff 에게 샌다.
  t('★★ 통계 맵을 응답에 통째로 싣지 않는다(스코프는 tabs 루프가 유일한 방어)',
    !/res\.json\([^)]*\bstats\b\s*[,}]/.test(ROUTES), (ROUTES.match(/res\.json\([^)]*stats[^)]*\)/g) || []).join(' | '));

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
    /function _finAbsorb\(r\)\{[\s\S]{0,700}STATE\.tabs\.forEach\(t=>\{ const n=by\[/.test(WD));
  // ★★ 코드리뷰가 잡은 무신호 사고 계열 — 조회 실패를 빈 값으로 덮으면 마감이 통째로 풀린 것처럼 보인다
  t('★★ 마감 조회 실패 응답으로 기존 마감 표시를 덮지 않는다(_finAbsorb)',
    /if\(!r\.finishedUnavailable\)\{ t\.finished=!!n\.finished/.test(WD));
  t('★★ loadTabs 도 실패 응답에서 기존 마감 표시를 이월한다(작업보드 부활 차단)',
    /if\(r\.finishedUnavailable && _prevFin\[k\]\)\{ t\.finished=true/.test(WD));
  t('★ 통계는 값이 있을 때만 대입(undefined 로 덮으면 마감 후보 배지가 통째로 사라진다)',
    /if\(n\.stats\) t\.stats=n\.stats;/.test(WD));
  t('★ 실패·잘림을 화면이 말한다(조용한 정상 위장 금지)',
    /_finNoticeHtml\(\)\{[\s\S]{0,700}finUnavailable[\s\S]{0,400}statsUnavailable[\s\S]{0,400}finTruncated/.test(WD));
  t('★ loadTabs 가 홈 목록도 다시 그린다(배열 교체로 목록 인덱스가 stale 이 되면 옆 작업을 마감한다)',
    /_renderTabList\(\);[\s\S]{0,400}if\(document\.getElementById\('wblMount'\)\) _finRenderList\(\);/.test(WD));
  t('★ 복귀 확인창에 작업 이름을 넣는다(인덱스가 어긋났을 때 사용자가 알아챌 유일한 장치)',
    /_finReopen\(tab\)\{[\s\S]{0,700}confirm\(`"\$\{tabName\}"/.test(WD));
  t('★ 0행 복귀를 "되돌렸습니다"로 꾸미지 않는다', /r\.reopened \? '진행중으로 되돌렸습니다' : '이미 진행중인 작업이었습니다'/.test(WD));
  t('★ 전부 마감이면 "이 그룹에 작업이 없습니다"가 아니라 보관함으로 안내(그룹 자체가 없는 상태)',
    /if\(!gs\.length\)\{[\s\S]{0,300}마감 보관함에 있습니다/.test(WD));

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
