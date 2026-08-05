/**
 * homeCampaignButton.test.js — 홈 작업목록 → [공고] 버튼 + 버튼 열 고정 + 오늘 완료 색표시 회귀가드
 * 실행: node tests/homeCampaignButton.test.js
 * 시안: frontend/docs/design-home-campaign-popup.html (사용자 확정)
 *
 * 이 변경에서 깨지면 아픈 것 여섯.
 *  ① **조용한 "공고 없음"** — 연결 조회 실패를 빈 값으로 접으면 담당자가 **이미 있는 공고를 또 발행**한다.
 *     서버는 `campaignsUnavailable` 로 말하고, 프론트는 그 응답으로 기존 주석을 **덮지 않아야** 한다.
 *  ② **스코프 누수** — 공고 주석 맵은 전 탭 무스코프다. 응답에 통째로 실으면 담당 밖 캠페인명이 staff 에게 샌다.
 *     (stats 맵과 같은 규율 — tabs 루프가 유일한 스코프)
 *  ③ **상태 불일치** — 점 색이 카드·리뷰어 목록과 다른 계산으로 나오면 "목록엔 모집중인데 참여는 거부"가 된다.
 *     → `computeCampaignState` 를 실제로 태우는지 고정.
 *  ④ **XSS** — onclick 에 시트/공고에서 온 문자열을 넣으면 따옴표 하나로 탈출된다(레포 실측 사고). 인덱스만.
 *  ⑤ **버튼 열 흔들림** — flex(내용 폭)로 되돌리면 같은 버튼이 줄마다 다른 자리에 온다(사용자 신고).
 *  ⑥ **오늘 완료 라벨 스왑 부활** — '☑ 오늘 완료' ↔ '해제' 로 글자가 바뀌면 폭이 달라져 ⑤ 가 재발한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 홈 작업목록 [공고] 버튼 회귀가드\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const ROUTES = S('src/routes/trackB.routes.js');
const SVC_SRC = S('src/services/trackB.service.js');
const IR = F('js/index-recruit.js');

/* ── 1) 서비스 — 스텁 pool 로 실제 실행 ───────────────────────── */
console.log('1) tabCampaignsMap (서비스 실행)');
const pool = require('../src/db/pool');
const svc = require('../src/services/trackB.service');
const origQuery = pool.query.bind(pool);
let SQL = [];
const stub = (impl) => { SQL = []; pool.query = async (q, p) => { SQL.push({ q: String(q), p }); return impl ? impl(String(q), p) : { rows: [], rowCount: 0 }; }; };

const CAMP = (o) => Object.assign({
  id: 'c1', title: '공고A', status: 'active', participation_mode: false,
  linked_sheet_id: 'S1', linked_tab_name: 'T1', linked_tab_gid: '111',
  created_at: new Date('2026-08-01T00:00:00Z'),
}, o);

const isCampSelect = q => /FROM recruit_campaigns/.test(q) && /linked_sheet_id/.test(q);

(async () => {
  // ★ 캐시(30초)가 케이스 간에 새지 않도록 매번 force
  stub(q => (isCampSelect(q)
    ? { rows: [CAMP({ id: 'c1', title: '최신', created_at: new Date('2026-08-03T00:00:00Z') }),
               CAMP({ id: 'c2', title: '이전', created_at: new Date('2026-07-01T00:00:00Z') })] }
    : { rows: [] }));
  let r = await svc.tabCampaignsMap({ force: true });
  t('ok:true + 이름 키에 배열', r.ok && Array.isArray(r.map['S1\tT1']), JSON.stringify(Object.keys(r.map)));
  t('한 탭에 여러 공고를 **배열로** 준다(차수 재발행 — 화면이 고르게 한다)', r.map['S1\tT1'].length === 2);
  t('정렬은 SQL 이 created_at DESC(최신 먼저)', /ORDER BY created_at DESC/.test(SQL.find(x => isCampSelect(x.q)).q));
  t('★ gid 폴백 키도 함께 만든다(탭 리네임으로 연결이 조용히 풀리는 것 방지)', Array.isArray(r.map['S1\tgid:111']));
  t('생성일을 함께 준다(사용자 확정 — 고를 때 근거)', !!r.map['S1\tT1'][0].createdAt);
  t('제목·id 를 준다', r.map['S1\tT1'][0].id === 'c1' && r.map['S1\tT1'][0].title === '최신');

  // 빈 gid 는 키를 만들지 않는다(만들면 gid 없는 탭이 전부 한 키로 뭉쳐 남의 공고가 붙는다)
  stub(q => (isCampSelect(q) ? { rows: [CAMP({ linked_tab_gid: '' })] } : { rows: [] }));
  r = await svc.tabCampaignsMap({ force: true });
  t('★ 빈 gid 는 gid 키를 만들지 않는다', !Object.keys(r.map).some(k => /\tgid:$/.test(k)), JSON.stringify(Object.keys(r.map)));

  // 참여형 = 상태엔진(computeCampaignState)을 실제로 태운다 — 카드와 같은 계산
  stub(q => (isCampSelect(q)
    ? { rows: [CAMP({ participation_mode: true, status: 'active', daily_limit: 10, recruit_total: 100, window_start: null, window_end: null })] }
    : { rows: [] }));
  r = await svc.tabCampaignsMap({ force: true });
  const it = r.map['S1\tT1'][0];
  t('★ 참여형은 상태엔진 값을 싣는다(자율주문 = 종일 open)', it.state === 'open', JSON.stringify(it));
  t('participationMode 를 함께 준다', it.participationMode === true);

  // 레거시(참여형 아님) = state:'legacy' — 화면이 status 로 라벨을 만든다
  stub(q => (isCampSelect(q) ? { rows: [CAMP({ participation_mode: false, status: 'closed' })] } : { rows: [] }));
  r = await svc.tabCampaignsMap({ force: true });
  t('레거시 공고도 목록에 나온다(state=legacy + status 동봉)',
    r.map['S1\tT1'][0].state === 'legacy' && r.map['S1\tT1'][0].status === 'closed');

  // 조회 실패 = {ok:false} (빈 맵만 주면 화면이 "공고 없음"으로 읽는다)
  pool.query = async () => { throw new Error('boom'); };
  r = await svc.tabCampaignsMap({ force: true });
  t('★ 조회 실패는 ok:false 로 말한다(빈 맵과 구분 — 088 규율)', r.ok === false && r.map && !Object.keys(r.map).length);

  // 상태 재료(counts/일정) 실패는 목록까지 죽이지 않는다
  let n = 0;
  pool.query = async (q) => { if (isCampSelect(String(q))) { n++; return { rows: [CAMP({ participation_mode: true })] }; } throw new Error('counts down'); };
  r = await svc.tabCampaignsMap({ force: true });
  t('★ 상태 재료 실패 → 공고 목록은 그대로, 상태만 비운다', r.ok === true && r.map['S1\tT1'].length === 1, JSON.stringify(r.map['S1\tT1']));

  pool.query = origQuery;

  /* ── 2) 라우트 — 스택 실검사 + 핸들러 실제 호출 ────────────────── */
  console.log('\n2) GET /tabs 주석 (라우트 실행)');
  const router = require('../src/routes/trackB.routes');
  const L = {};
  router.stack.filter(l => l.route).forEach(l => {
    const m = Object.keys(l.route.methods)[0];
    L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
  });
  t('GET /tabs 등록 + authMiddleware 가 맨 앞', Array.isArray(L['GET /tabs']) && L['GET /tabs'][0] === 'authMiddleware', JSON.stringify(L['GET /tabs']));

  const handler = router.stack.find(l => l.route && l.route.path === '/tabs' && l.route.methods.get)
    .route.stack.slice(-1)[0].handle;
  const call = async (query, admin, over) => {
    const saved = {};
    const fake = Object.assign({
      scopedActiveTabs: async () => [{ sheetId: 'S1', tabName: 'T1', tabGid: '111' }, { sheetId: 'S1', tabName: 'T2', tabGid: '' }],
      finishedTabsMap: async () => ({ ok: true, map: {} }),
      tabStatsMap: async () => ({ ok: true, map: {} }),
      dailyDoneMap: async () => ({ ok: true, map: {}, date: '2026-08-05' }),
      tabCampaignsMap: async () => ({ ok: true, map: { 'S1\tT1': [{ id: 'c1', title: '공고A', state: 'open', createdAt: 'x' }], 'S9\tT9': [{ id: 'zz', title: '남의 공고' }] } }),
    }, over || {});
    Object.keys(fake).forEach(k => { saved[k] = svc[k]; svc[k] = fake[k]; });
    let out = null;
    await handler({ query, admin: admin || { role: 'admin', name: 'A' } }, { json: (o) => { out = o; }, status() { return this; } }, e => { throw e; });
    Object.keys(saved).forEach(k => { svc[k] = saved[k]; });
    return out;
  };

  let out = await call({ stats: '1' });
  t('연결된 공고가 그 탭에만 실린다', Array.isArray(out.tabs[0].campaigns) && out.tabs[0].campaigns[0].id === 'c1');
  t('연결 없는 탭에는 campaigns 가 없다(빈 배열도 만들지 않는다)', out.tabs[1].campaigns === undefined);
  t('★ 맵 자체를 응답에 싣지 않는다(무스코프 누수 차단)',
    !JSON.stringify(out).includes('남의 공고'), JSON.stringify(Object.keys(out)));

  out = await call({});
  t('stats=1 없으면 공고 주석을 조회하지 않는다(홈 전용 — 작업바 로드는 가볍게)',
    out.tabs.every(x => x.campaigns === undefined));

  out = await call({ stats: '1' }, null, { tabCampaignsMap: async () => ({ ok: false, map: {} }) });
  t('★ 조회 실패는 campaignsUnavailable 로 고지', out.campaignsUnavailable === true);

  out = await call({ stats: '1' }, { role: 'advertiser', advertiser_id: 'a1' });
  t('★ 광고주에게는 공고 주석을 아예 안 붙인다(내부 정보 — 마감 주석과 같은 판단)',
    out.tabs.every(x => x.campaigns === undefined) && out.campaignsUnavailable === undefined);

  let forced = null;
  await call({ stats: '1', fresh: '1' }, null, { tabCampaignsMap: async (o) => { forced = o; return { ok: true, map: {} }; } });
  t('fresh=1 이면 30초 캐시를 건너뛴다(방금 발행한 공고가 바로 잡히게)', !!(forced && forced.force === true));

  /* ── 3) 서비스 소스 규율 ──────────────────────────────────────── */
  console.log('\n3) 상태 판정 단일 출처');
  const fn = SVC_SRC.slice(SVC_SRC.indexOf('async function tabCampaignsMap'), SVC_SRC.indexOf('// ══ M2: 열린 작업 줄'));
  t('★ computeCampaignState 를 쓴다(status 컬럼으로 상태를 흉내 내지 않는다)', /computeCampaignState\(/.test(fn));
  t('★ 시트 일정(deriveSchedules)도 같은 재료로 넘긴다(카드와 같은 정원·마감)', /deriveSchedules\(/.test(fn) && /scheduleFor\(/.test(fn));
  // ★ 대상 목록도 공유 헬퍼로 — 손으로 map 하면 그쪽 필터(참여형 + gid 보유)와 갈라져 다른 일정이 적용된다.
  t('★ 일정 대상은 공유 헬퍼 tabsOfCampaigns 로 뽑는다(사본 금지)',
    /deriveSchedules\(db, tabsOfCampaigns\(rows\), now\)/.test(fn) && !/tabsOf\s*=\s*rows\.map/.test(fn));
  t('연결 탭 있는 공고만 조회한다(전 공고 스캔 금지)', /linked_sheet_id, ''\) <> ''/.test(fn) || /COALESCE\(linked_sheet_id/.test(fn));
  t('쓰기 없음 — 읽기 전용', !/\b(INSERT|UPDATE|DELETE)\b/i.test(fn));

  /* ── 4) 프론트 — 버튼 렌더러 vm 실행 ─────────────────────────── */
  console.log('\n4) [공고] 버튼 렌더 (vm 실행)');
  const grab = (start, end) => {
    const a = WD.indexOf(start), b = WD.indexOf(end);
    assert(a > 0 && b > a, '블록 추출 실패: ' + start);
    return WD.slice(a, b);
  };
  const block = grab('const _CAMP_LABEL=', 'function _finRenderList()');
  const ctx = {
    STATE: { campEdit: true, campsUnavailable: false },
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    api: async () => ({ ok: true }), toast() {}, document: { getElementById: () => null }, window: {},
  };
  vm.createContext(ctx);
  // ★ sandbox 에 openRecruitModal 등을 일부러 두지 않는다 — 렌더 경로가 그것을 참조하면 여기서 터진다.
  vm.runInContext(block, ctx);

  const tab = (camps) => ({ sheetId: 'S1', tabName: "x'),alert(1),String('", tabGid: '1', campaigns: camps });
  let h = ctx._campBtnHtml(tab([{ id: 'c1', title: '공고A', state: 'open' }]), 3);
  t('모집중 = 초록 점', /wbl-cdot open/.test(h), h);
  t('★ onclick 에는 인덱스만(시트/공고 문자열 미보간 — XSS)', /openTabCampaign\(3\)/.test(h) && !/alert\(1\)/.test(h), h);
  t('제목·상태를 title 툴팁으로', /title="[^"]*공고A[^"]*모집중/.test(h), h);

  h = ctx._campBtnHtml(tab([{ id: 'c1', state: 'preopen' }]), 0);
  t('오픈예정 = 주황 점', /wbl-cdot pre/.test(h), h);
  h = ctx._campBtnHtml(tab([{ id: 'c1', state: 'closed' }]), 0);
  t('마감 = 회색 점(등급 클래스 없음)', /wbl-cdot "/.test(h) || /wbl-cdot ">/.test(h) || /class="wbl-cdot\s*"/.test(h), h);
  h = ctx._campBtnHtml(tab([{ id: 'a', state: 'closed' }, { id: 'b', state: 'open' }]), 1);
  t('여러 건이면 개수를 표시하고 점은 가장 열린 상태', /공고 2/.test(h) && /wbl-cdot open/.test(h), h);

  h = ctx._campBtnHtml(tab([]), 2);
  t('미발행(편집자) = ＋공고발행 — 띄어쓰기 없이 같은 칸 폭', /＋공고발행/.test(h) && !/＋ 공고 발행/.test(h), h);
  ctx.STATE.campEdit = false;
  h = ctx._campBtnHtml(tab([]), 2);
  t('★ 편집 권한 없으면 발행 버튼을 아예 안 준다(눌러도 아무 일 없는 버튼 금지)', /disabled/.test(h) && !/openTabCampaign/.test(h), h);
  ctx.STATE.campEdit = true;

  ctx.STATE.campsUnavailable = true;
  h = ctx._campBtnHtml(tab([]), 2);
  t('★ 조회 실패는 "공고 없음"이 아니라 비활성 + 사유(중복 발행 차단)',
    /disabled/.test(h) && /공고 \?/.test(h) && !/＋공고발행/.test(h), h);
  ctx.STATE.campsUnavailable = false;

  t('레거시 공고 라벨은 status 로 만든다', ctx._campLabel({ state: 'legacy', status: 'active' }) === '진행중');
  t('레거시 마감도 회색(등급 2)', ctx._campRank({ state: 'legacy', status: 'closed' }) === 2);

  /* ── 5) 프론트 배선 ──────────────────────────────────────────── */
  console.log('\n5) 배선 · 열 고정 · 오늘 완료 표시');
  t('목록 행 액션에 [공고] 버튼이 들어간다', /_campBtnHtml\(t,i\)/.test(WD));
  t('★ 버튼 열 고정 — .wbl-act 는 고정 폭 grid(flex 로 되돌리면 줄마다 흔들린다)',
    /\.wbl-act\{display:grid;grid-template-columns:92px 46px 88px 64px/.test(WD));
  t('마감 보관함·열람전용은 칸 수가 달라 별도 template', /\.wbl-act\.fin\{grid-template-columns/.test(WD) && /\.wbl-act\.ro\{grid-template-columns/.test(WD));
  t('버튼이 칸을 채운다(width:100%)', /\.wbl-act \.wbl-b\{width:100%/.test(WD));
  t('★ 오늘 완료 라벨 스왑 부활 금지(폭이 달라져 열이 어긋난다)',
    !/\$\{td\?'해제':'☑ 오늘 완료'\}/.test(WD) && /title="\$\{td\?'오늘 완료됨[^"]*}">☑ 오늘 완료</.test(WD));
  t('★ 켜짐은 파란 채움으로 말한다', /\.wbl-b\.today\.on\{background:var\(--accent\);/.test(WD));
  t('조회 실패를 목록 상단에도 고지', /campsUnavailable[\s\S]{0,120}\[공고\] 버튼이 잠시 비활성/.test(WD));
  t('★ 실패 응답으로 기존 공고 주석을 덮지 않는다', /if\(!r\.campaignsUnavailable\) t\.campaigns=n\.campaigns\|\|\[\]/.test(WD));
  t('작업바 로드(stats 없음)에서 주석을 이월한다(버튼이 깜빡이며 사라지지 않게)', /_prevCamp\[k\]/.test(WD));
  t('여러 건은 생성일과 함께 고르게 한다(사용자 확정)', /_campPickerOpen/.test(WD) && /생성/.test(WD.slice(WD.indexOf('_campPickerOpen'), WD.indexOf('_campPickerClose'))));
  t('★ 선택 목록도 인덱스만 넘긴다', /_campPick\(\$\{i\},\$\{ci\}\)/.test(WD));
  t('모달은 기존 공유 모달을 그대로 연다(사본 금지)', /openRecruitModal\(id\|\|null, prefill\)/.test(WD));
  t('연결 탭 드롭다운 재료를 먼저 채운다(_recruitTabList 의존)', /loadRecruitTabOptions/.test(WD.slice(WD.indexOf('async function _campOpenModal'), WD.indexOf('function _campPickerOpen'))));
  t('미발행은 그 작업의 탭을 프리필한다', /linked_sheet_id:t\.sheetId, linked_tab_name:t\.tabName/.test(WD));
  t('★ 편집 권한은 홈 전용 플래그(STATE.campEdit) — 그리드 편집 플래그와 섞지 않는다',
    /STATE\.campEdit=!!\(r&&r\.ok&&r\.canEdit\)/.test(WD) && /campEdit:null/.test(WD));
  t('계정 전환 시 편집 플래그를 비운다(logout·401 둘 다)',
    (WD.match(/campEdit:null,campsUnavailable:false/g) || []).length >= 2);

  /* ── 6) 공유 모듈 무회귀 ─────────────────────────────────────── */
  console.log('\n6) index-recruit.js (관리자 대시보드 무회귀)');
  t('★ 목록 컨테이너 없는 화면에서 저장해도 "저장 오류"가 뜨지 않는다', /if \(!wrap\) return;/.test(IR));
  t('저장 후 호스트 훅을 부른다(훅 미설정 = 기존 동작 불변)', /window\.CAMP_ON_SAVED === "function"/.test(IR));
  t('홈이 그 훅으로 주석을 새로 받는다(30초 캐시 우회)', /window\.CAMP_ON_SAVED=function/.test(WD) && /fresh=1/.test(WD));

  console.log(`\n✅ 통과 ${pass}건\n`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message + '\n'); process.exit(1); });
