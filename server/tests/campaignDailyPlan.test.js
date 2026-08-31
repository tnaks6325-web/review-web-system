/**
 * campaignDailyPlan.test.js — 날짜별 모집인원 조절 + 차수(095) 회귀가드.
 *
 * 배경(실사고): 업체 요청으로 "오늘은 20명만" 줄이면 시스템이 미달로 오해해 다음날 60명을
 * 자동 이월했고, "오늘만 +10명"은 반영할 수단이 없었다.
 * 시안 = frontend/docs/모집인원조절_이월차수_와이어프레임.html (사용자 확정 3건).
 *
 * ★★ 완화 금지 불변식
 *   ① 계획·차수가 하나도 없는 캠페인 = 기존 동작 100% (옵트인 — 무회귀).
 *   ② 명시 조절일 = 그 값이 그날의 전부(자연 이월을 얹지도 빼지도 않는다).
 *   ③ 총량 clamp 유지(조절로 총량 초과 불가) — 총량 변경은 차수 추가/제거로만.
 *   ④ 계획 조회 실패 = 계획 미적용(fail-open) — 목록/참여를 죽이면 안 된다.
 *   ⑤ 시트 일정 캠페인도 조절 저장 허용(사용자 확정 2026-08-07 — 종전 schedule_driven 거부 폐기).
 *      규칙은 "조절한 날짜만 시스템이 이긴다" — 조절하지 않은 날은 계속 시트를 따른다.
 *   ⑥ 균형 모드(요구 ①⑥)의 저장 게이트 = 배분 합계 ≡ 남은 배분수. 어긋나면 저장 잠금.
 *
 * 실행: node tests/campaignDailyPlan.test.js
 *   (PGTEST_URL=postgres://… 지정 시 진짜 PG로 마이그레이션·유니크·CASCADE까지 검증)
 */
process.env.PGTEST_SKIP_BOOT = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const readS = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8'));
const readF = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8'));
const readM = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', 'migrations', p), 'utf8'));

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const eq = (name, got, want) => ok(`${name} → ${got}`, got === want);

/* ═══════════════════════════════════════════════════════════
   0. 스텁 pool — 서비스 require 전에 심는다(실 DB 무접촉)
   ═══════════════════════════════════════════════════════════ */
const CALLS = [];
let STUB = {};   // 케이스별 라우팅: { match(sql) → rows | throw }
const poolMod = require('../src/db/pool');
const _dispatch = async (sql, params) => {
  CALLS.push({ sql: String(sql), params });
  for (const k of Object.keys(STUB)) {
    if (String(sql).includes(k)) {
      const v = STUB[k];
      if (typeof v === 'function') return v(sql, params);
      if (v instanceof Error) throw v;
      return { rows: v };
    }
  }
  return { rows: [] };
};
poolMod.query = _dispatch;
poolMod.connect = async () => ({ query: _dispatch, release: () => {} });

const S = require('../src/services/campaignState.service');
const today = S.kstTodayStr();
const d = (offset) => new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

/* ═══════════════════════════════════════════════════════════
   1. dailyQuota — 계획표 반영 순수함수 (사례 1·2 그대로)
   기본 = 일건수 40 · 총량 200 · 기준선 D-2(= 3일차)
   ═══════════════════════════════════════════════════════════ */
console.log('\n[1] dailyQuota 계획표 반영');
const CAMP = {
  participation_mode: true, status: 'active',
  daily_limit: 40, recruit_total: 200, start_date: null,
  window_start: null, window_end: null, close_buffer_min: 10,
};
const carry = (submittedSince, over = {}) => ({ startDate: d(-2), today, submittedSince, ...over });
const ctx = (plans) => ({ today, plans });

// ★ 불변식 ① — 계획이 없으면 종전 결과와 완전히 동일(옵트인 무회귀)
for (const [before, since] of [[80, 80], [70, 70], [0, 0], [190, 110]]) {
  const legacy = S.dailyQuota(CAMP, before, carry(since));
  eq(`무계획 = 종전과 동일 (before=${before})`, S.dailyQuota(CAMP, before, carry(since), ctx(null)), legacy);
}

// 사례 1(실사고): 이틀 40씩 채우고 오늘 업체 요청으로 20으로 조절
eq('★ 사례1: 오늘 조절 20 → 정확히 20 (자연 이월 무시 — "오늘은 20명만"의 의미)',
  S.dailyQuota(CAMP, 80, carry(80), ctx({ [today]: 20 })), 20);
eq('★ 사례1 재현(계획 없던 옛 동작): 어제 20명 미달이면 오늘 60 — 이것이 사고였다',
  S.dailyQuota(CAMP, 80, { startDate: d(-3), today, submittedSince: 100 }), 60);
// 어제(=D-1)를 20으로 조절했고 실제 20명 채움 → 오늘은 40 그대로(+20 이월 없음)
eq('★ 사례1 해결: 어제 조절 20 · 20명 채움 → 오늘 40 그대로 (다음날 60 사고 소멸)',
  S.dailyQuota(CAMP, 100, { startDate: d(-3), today, submittedSince: 100 }, ctx({ [d(-1)]: 20 })), 40);
// 조절한 날 또 미달(20 계획, 15명) → 조절된 계획 기준으로 미달 5만 이월
eq('축소일 또 미달: 어제 20 계획·15명 → 오늘 45 (조절 계획 기준 5명만 이월)',
  S.dailyQuota(CAMP, 95, { startDate: d(-3), today, submittedSince: 95 }, ctx({ [d(-1)]: 20 })), 45);

// 사례 2: 오늘만 50으로 증원 → 오늘 50, 내일은 40 그대로(30으로 줄지 않음)
eq('★ 사례2: 오늘 조절 50 → 50', S.dailyQuota(CAMP, 80, carry(80), ctx({ [today]: 50 })), 50);
eq('★ 사례2: 어제 조절 50 · 50명 채움 → 오늘 40 그대로 (30으로 줄이지 않는다)',
  S.dailyQuota(CAMP, 130, { startDate: d(-3), today, submittedSince: 130 }, ctx({ [d(-1)]: 50 })), 40);
eq('사례2 미달분: 어제 50 계획·45명 → 오늘 45 (5명 이월)',
  S.dailyQuota(CAMP, 125, { startDate: d(-3), today, submittedSince: 125 }, ctx({ [d(-1)]: 50 })), 45);

// 경계·불변식
eq('조절 0 = 그날 휴무(아예 안 연다)', S.dailyQuota(CAMP, 80, carry(80), ctx({ [today]: 0 })), 0);
eq('★ 불변식 ③: 총량 clamp — 조절 50이어도 남은 자리 10이면 10',
  S.dailyQuota(CAMP, 190, carry(110), ctx({ [today]: 50 })), 10);
eq('★ 조절일엔 이월 상한도 무관하게 그 값(대량 미달 + 조절 30 → 30)',
  S.dailyQuota(CAMP, 40, { startDate: d(-3), today, submittedSince: 40 }, ctx({ [today]: 30 })), 30);
eq('비조절일 이월 상한(2배)은 그대로: 대량 미달 → 80',
  S.dailyQuota(CAMP, 40, { startDate: d(-3), today, submittedSince: 40 }, ctx({ [d(5)]: 99 })), 80);
eq('carry 없어도(기준선 조회 실패) 오늘 조절값은 적용 — 조절 기능이 degraded 에 죽지 않는다',
  S.dailyQuota(CAMP, 80, null, ctx({ [today]: 20 })), 20);
eq('미래 날짜 계획은 오늘 정원에 영향 없음',
  S.dailyQuota(CAMP, 80, carry(80), ctx({ [d(3)]: 5 })), 40);

// ★ 139: 모집공고 설정의 배치 전략은 서버 정원 계산에 직접 반영된다.
// 기존 NULL은 next로 해석해 배포만으로 운영 중인 공고를 재배치하지 않는다.
{
  const strategyCamp = { ...CAMP, daily_limit: 20, recruit_total: 80 };
  const strategyCarry = { startDate: d(-1), today, submittedSince: 15 }; // 첫날 20명 중 15명 확정 → 미달 5
  eq('139 기존 공고의 전략 NULL = 현행 다음날 가산',
    S.carryStrategy(strategyCamp), 'next');
  eq('139 다음날 더하기 = 미달 5가 다음날 정원에 가산',
    S.dailyQuota({ ...strategyCamp, carry_strategy: 'next' }, 15, strategyCarry), 25);
  eq('139 종료일 뒤에 붙이기 = 다음날은 기본 일건수 유지',
    S.dailyQuota({ ...strategyCamp, carry_strategy: 'extend' }, 15, strategyCarry), 20);
  eq('139 남은 날에 나눠담기 = 원래 종료일까지 분산',
    S.dailyQuota({ ...strategyCamp, carry_strategy: 'spread' }, 15, strategyCarry), 22);
  eq('139 명시 날짜계획은 종료일 연장보다 우선',
    S.dailyQuota({ ...strategyCamp, carry_strategy: 'extend' }, 15, strategyCarry, ctx({ [today]: 12 })), 12);
  eq('139 종료일 연장도 총원 잔여량 clamp 유지',
    S.dailyQuota({ ...strategyCamp, carry_strategy: 'extend' }, 77, strategyCarry), 3);
}

// 킬스위치 — require 시점 상수라 자식 프로세스로 검증(계획 무시 = 전건 기존 동작)
{
  const out = execFileSync(process.execPath, ['-e', `
    const S = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'campaignState.service.js'))});
    const CAMP = { daily_limit: 40, recruit_total: 200 };
    const q = S.dailyQuota(CAMP, 80, { startDate: '2026-08-04', today: '2026-08-06', submittedSince: 80 },
      { today: '2026-08-06', plans: { '2026-08-06': 20 } });
    console.log(q);
  `], { env: { ...process.env, CAMPAIGN_DAILY_PLAN: '0' } }).toString().trim();
  eq('★ 킬스위치 CAMPAIGN_DAILY_PLAN=0 → 조절 무시(40)', out, '40');
}

/* ═══════════════════════════════════════════════════════════
   2. computeCampaignState — payload(todayPlanned/planAdjusted/carryAdded)
   ═══════════════════════════════════════════════════════════ */
console.log('\n[2] computeCampaignState 표시 재료');
const CNT = (over = {}) => ({
  activeHolds: 0, todayActiveHolds: 0, submittedAll: 80, todaySubmitted: 0, submittedBeforeToday: 80,
  carry: { startDate: d(-2), submittedSince: 80 }, plans: null, ...over,
});
{
  const st = S.computeCampaignState(CAMP, CNT({ plans: { [today]: 20 } }));
  eq('조절일 dailyQuota', st.dailyQuota, 20);
  eq('조절일 todayPlanned', st.todayPlanned, 20);
  eq('조절일 planAdjusted', st.planAdjusted, true);
  eq('★ 조절일 carryAdded=0 (조절을 "+N 이월"로 위장하지 않는다)', st.carryAdded, 0);
}
{
  const st = S.computeCampaignState(CAMP, CNT());
  eq('무계획 todayPlanned=null', st.todayPlanned, null);
  eq('무계획 planAdjusted=false', st.planAdjusted, false);
}
{
  const st = S.computeCampaignState(CAMP, CNT({ todaySubmitted: 20, submittedAll: 100, plans: { [today]: 20 } }));
  eq('조절 20 다 차면 daily_done', st.state, 'daily_done');
}
{
  // ★★ 시트 일정 캠페인(063)도 조절 가능(사용자 확정 2026-08-07 — 종전 "계획 무시" 규칙 폐기).
  //   규칙 = **조절한 날짜만** 리뷰웹이 이기고, 조절하지 않은 날은 종전대로 시트가 정한다.
  //   되돌리면 휴무일·일정종료 공고의 이월을 어디서도 조절할 수 없던 상태로 회귀한다.
  const sch = {
    ok: true, dates: [{ date: today, slots: 5 }, { date: d(1), slots: 5 }],
    byDate: { [today]: 5, [d(1)]: 5 }, totalSlots: 10, firstDate: today, lastDate: d(1),
  };
  const base = CNT({ submittedAll: 0, submittedBeforeToday: 0 });
  eq('조절 없는 날은 종전대로 시트 값(5)',
    S.computeCampaignState(CAMP, base, new Date(), sch).dailyQuota, 5);
  const st = S.computeCampaignState(CAMP, CNT({ submittedAll: 0, submittedBeforeToday: 0, plans: { [today]: 8 } }), new Date(), sch);
  eq('★ 시트 일정 공고도 조절값이 이긴다(시트 5 → 조절 8)', st.dailyQuota, 8);
  eq('시트 일정 공고 todayPlanned', st.todayPlanned, 8);
  eq('시트 일정 공고 planAdjusted', st.planAdjusted, true);
  // ★ 총량 clamp 는 유지 — 시트 총건수(10)를 넘겨 열 수 없다(095 불변식 ②)
  eq('★ 총량 clamp 유지(조절 20이어도 총 10 − 확정 0 = 10)',
    S.computeCampaignState(CAMP, CNT({ submittedAll: 0, submittedBeforeToday: 0, plans: { [today]: 20 } }), new Date(), sch).dailyQuota, 10);
  eq('★ 총량 clamp 유지(전일 확정 7 → 남은 3)',
    S.computeCampaignState(CAMP, CNT({ submittedAll: 7, submittedBeforeToday: 7, plans: { [today]: 20 } }), new Date(), sch).dailyQuota, 3);
}
{
  // ★★★ 코드리뷰 Blocker — 조절한 **다음 날**: 축소분이 자동 이월되면 095 가 존재하는 이유가 무너진다.
  //   (수정 전 실측: 오늘 20→5 축소 + 5명 참여 → 다음날이 시트 20이 아니라 **35** 로 열렸다)
  //   판정은 어제 조절값을 계획 누적에 반영하는 planDeltaThrough 가 담당한다.
  const sch = {
    ok: true, dates: [{ date: d(-1), slots: 20 }, { date: today, slots: 20 }, { date: d(1), slots: 20 }],
    byDate: { [d(-1)]: 20, [today]: 20, [d(1)]: 20 }, totalSlots: 100, firstDate: d(-1), lastDate: d(1),
  };
  const q = (o) => S.computeCampaignState(CAMP, CNT(o), new Date(), sch).dailyQuota;
  eq('★★ 축소한 다음 날 = 시트 값 그대로(축소분 자동 이월 금지: 어제 5로 줄이고 5명 참여 → 오늘 20)',
    q({ submittedAll: 5, submittedBeforeToday: 5, plans: { [d(-1)]: 5 } }), 20);
  eq('★★ 증가한 다음 날도 시트 값 그대로(어제 30으로 늘려 30명 참여 → 오늘 20, 다음날에서 뺏지 않는다)',
    q({ submittedAll: 30, submittedBeforeToday: 30, plans: { [d(-1)]: 30 } }), 20);
  eq('★ 조절일의 자연 미달은 살아남는다(어제 5로 줄였는데 3명만 → 오늘 20+2=22)',
    q({ submittedAll: 3, submittedBeforeToday: 3, plans: { [d(-1)]: 5 } }), 22);
  eq('조절 없는 흐름은 종전대로 이월(어제 20 중 15명 → 오늘 25)',
    q({ submittedAll: 15, submittedBeforeToday: 15 }), 25);
  eq('미래 조절은 오늘 정원에 영향 없음',
    q({ submittedAll: 20, submittedBeforeToday: 20, plans: { [d(1)]: 99 } }), 20);
}
{
  // ★★ 휴무일(시트에 오늘 행 0개)이어도 **명시 조절값(1명 이상)이 있으면 연다** —
  //   "저장했는데 안 열린다"(조용한 no-op) 방지. 0명 조절은 '안 연다'는 뜻이라 휴무 유지.
  const sch = {
    ok: true, dates: [{ date: d(-1), slots: 5 }, { date: d(1), slots: 5 }],
    byDate: { [d(-1)]: 5, [d(1)]: 5 }, totalSlots: 10, firstDate: d(-1), lastDate: d(1),
  };
  eq('휴무일 + 조절 없음 = 종전대로 rest_day',
    S.computeCampaignState(CAMP, CNT({ submittedAll: 5, submittedBeforeToday: 5 }), new Date(), sch).stateReason, 'rest_day');
  const st = S.computeCampaignState(CAMP, CNT({ submittedAll: 5, submittedBeforeToday: 5, plans: { [today]: 3 } }), new Date(), sch);
  eq('★ 휴무일이어도 조절 3명이면 연다', st.state, 'open');
  eq('휴무일 조절 정원', st.dailyQuota, 3);
  eq('★ 0명 조절은 휴무 유지(안 연다는 뜻)',
    S.computeCampaignState(CAMP, CNT({ submittedAll: 5, submittedBeforeToday: 5, plans: { [today]: 0 } }), new Date(), sch).stateReason, 'rest_day');
}
{
  // ★ 일정 종료(마감일 경과)도 같은 규율 — 조절값이 있으면 그날은 다시 열린다
  const sch = {
    ok: true, dates: [{ date: d(-3), slots: 5 }, { date: d(-2), slots: 5 }],
    byDate: { [d(-3)]: 5, [d(-2)]: 5 }, totalSlots: 10, firstDate: d(-3), lastDate: d(-2),
  };
  eq('일정 종료 + 조절 없음 = 종전대로 closed',
    S.computeCampaignState(CAMP, CNT({ submittedAll: 0, submittedBeforeToday: 0 }), new Date(), sch).stateReason, 'schedule_ended');
  eq('★ 일정 종료 + 조절 2명 = 다시 열림',
    S.computeCampaignState(CAMP, CNT({ submittedAll: 0, submittedBeforeToday: 0, plans: { [today]: 2 } }), new Date(), sch).state, 'open');
}

/* ═══════════════════════════════════════════════════════════
   3. _loadPlanMaps / fetchCampaignCounts — fail-open + plans 동봉
   ═══════════════════════════════════════════════════════════ */
console.log('\n[3] 계획 로더 fail-open + counts 동봉');
(async () => {
  // 3a. 정상: plans 가 counts 에 실린다
  S.__resetCarryCacheForTest();
  S.__resetPlanCacheForTest();
  STUB = {
    'app_settings': [{ key: 'campaign_carry_start', value: d(-2) }],
    'FROM campaign_daily_plans': [{ campaign_id: 'c1', d: today, planned_count: 20 }],
    'FROM campaign_applications': [],
  };
  CALLS.length = 0;
  let m = await S.fetchCampaignCounts(poolMod, ['c1', 'c2']);
  ok('plans 동봉(c1)', m.get('c1').plans && m.get('c1').plans[today] === 20);
  ok('계획 없는 캠페인은 plans=null(c2)', m.get('c2').plans === null);

  // 3b. 42P01 = fail-open + 네거티브 캐시(재조회 안 함)
  S.__resetCarryCacheForTest();
  S.__resetPlanCacheForTest();
  const e42 = new Error('relation does not exist');
  e42.code = '42P01';
  STUB = { 'app_settings': [{ key: 'campaign_carry_start', value: d(-2) }], 'FROM campaign_daily_plans': e42, 'FROM campaign_applications': [] };
  m = await S.fetchCampaignCounts(poolMod, ['c1']);
  ok('★ 테이블 부재 = plans null(목록·참여 무사)', m.get('c1').plans === null && m.get('c1').carry !== null);
  CALLS.length = 0;
  await S.fetchCampaignCounts(poolMod, ['c1']);
  ok('★ 42P01 네거티브 캐시 — 두 번째 호출은 계획 쿼리 0회',
    !CALLS.some(c => c.sql.includes('campaign_daily_plans')));
  S.__resetPlanCacheForTest();

  // 3c. 일반 오류도 fail-open(카운트는 나간다)
  S.__resetCarryCacheForTest();
  STUB = { 'app_settings': [{ key: 'campaign_carry_start', value: d(-2) }], 'FROM campaign_daily_plans': new Error('boom'), 'FROM campaign_applications': [] };
  m = await S.fetchCampaignCounts(poolMod, ['c1']);
  ok('일반 오류도 plans null + 카운트 정상', m.get('c1') && m.get('c1').plans === null);
  S.__resetPlanCacheForTest();

  // 3d. 잠금 클라이언트(release 보유)면 SAVEPOINT 격리(082 규율 — tx abort 전이 차단)
  const txCalls = [];
  const client = {
    release: () => {},
    query: async (sql) => {
      txCalls.push(String(sql));
      if (String(sql).includes('campaign_daily_plans')) { const e = new Error('x'); e.code = '42P01'; throw e; }
      if (String(sql).includes('app_settings')) return { rows: [{ key: 'campaign_carry_start', value: d(-2) }] };
      return { rows: [] };
    },
  };
  S.__resetCarryCacheForTest();
  S.__resetPlanCacheForTest();
  await S.fetchCampaignCounts(client, ['c1']);
  ok('★ client 경로는 SAVEPOINT → 실패 시 ROLLBACK TO (apply tx 보호)',
    txCalls.some(q => q.includes('SAVEPOINT cdp_plans')) && txCalls.some(q => q.includes('ROLLBACK TO SAVEPOINT cdp_plans')));
  S.__resetPlanCacheForTest();
  S.__resetCarryCacheForTest();

  /* ═══════════════════════════════════════════════════════════
     4. campaignPlan.service — 검증·게이트 (스텁 pool 실행)
     ═══════════════════════════════════════════════════════════ */
  console.log('\n[4] campaignPlan.service 실행');
  const P = require('../src/services/campaignPlan.service');
  const schedMod = require('../src/services/campaignSchedule.service');
  const origDerive = schedMod.deriveSchedules;
  const origFor = schedMod.scheduleFor;
  const CAMP_ROW = {
    id: 'c1', title: '테스트', status: 'active', participation_mode: true,
    daily_limit: 40, recruit_total: 200, start_date: null,
    linked_sheet_id: null, linked_tab_name: null, linked_tab_gid: null,
  };
  const baseStub = () => ({
    'FROM recruit_campaigns WHERE id': [CAMP_ROW],
    'FROM campaign_daily_plans': [],
    'FROM campaign_rounds': [],
    'campaign_plan_events': [],
    'FROM campaign_applications': [{ today_submitted: 0, today_holds: 0, n: 0 }],
  });
  schedMod.deriveSchedules = async () => new Map();
  schedMod.scheduleFor = () => null;

  // 4a. 과거 날짜 거부
  STUB = baseStub();
  await assert.rejects(P.savePlans('c1', { set: [{ date: d(-1), count: 10 }] }, 'tester'),
    (e) => e.code === 'past_date');
  ok('과거 날짜 조절 거부(past_date)', true);
  // 4b. 값 검증
  await assert.rejects(P.savePlans('c1', { set: [{ date: today, count: -1 }] }, 't'), (e) => e.code === 'bad_count');
  ok('음수 인원 거부(bad_count)', true);
  await assert.rejects(P.savePlans('c1', { set: [{ date: today, count: 5 }, { date: today, count: 6 }] }, 't'), (e) => e.code === 'dup_date');
  ok('같은 날짜 중복 거부(dup_date)', true);
  await assert.rejects(P.savePlans('c1', {}, 't'), (e) => e.code === 'empty');
  ok('빈 저장 거부(empty)', true);

  // 4c. ★ 원칙 ⑤ — 오늘 확정+홀드 아래로 축소 거부(floor 동봉)
  STUB = baseStub();
  STUB['FROM campaign_applications'] = [{ today_submitted: 20, today_holds: 5, n: 25 }];
  await assert.rejects(P.savePlans('c1', { set: [{ date: today, count: 20 }] }, 't'),
    (e) => e.code === 'below_used' && e.floor === 25);
  ok('★ 오늘 확정·진행(25) 아래 축소 거부 + floor 동봉', true);

  // 4d. 정상 저장: 업서트 + 이력 + 캠페인 행 FOR UPDATE(apply 직렬화)
  STUB = baseStub();
  CALLS.length = 0;
  const saved = await P.savePlans('c1', { set: [{ date: d(1), count: 50 }], remove: [], note: '증가' }, 'tester');
  eq('저장 applied', saved.applied, 1);
  ok('★ 캠페인 행 FOR UPDATE(축소↔apply write-skew 차단)', CALLS.some(c => c.sql.includes('FOR UPDATE')));
  ok('업서트 ON CONFLICT (campaign_id, plan_date)', CALLS.some(c => c.sql.includes('ON CONFLICT (campaign_id, plan_date)')));
  ok('이력(plan_save) 기록', CALLS.some(c => c.sql.includes('campaign_plan_events') && (c.params || [])[2] === 'plan_save'
    || (c.sql.includes('campaign_plan_events') && c.sql.includes('plan_save'))));

  // 4e. ★★ 시트 일정 캠페인도 저장 허용(사용자 확정 2026-08-07 — 종전 schedule_driven 거부 폐기).
  //   되돌리면 휴무일·일정종료 공고의 이월을 어디서도 조절할 수 없던 상태로 회귀한다.
  schedMod.scheduleFor = () => ({
    ok: true, dates: [{ date: today, slots: 5 }, { date: d(1), slots: 5 }],
    byDate: { [today]: 5, [d(1)]: 5 }, totalSlots: 10,
  });
  STUB = baseStub();
  CALLS.length = 0;
  const schSaved = await P.savePlans('c1', { set: [{ date: d(1), count: 9 }] }, 't');
  eq('★ 시트 일정 캠페인 저장 허용', schSaved.applied, 1);
  ok('★ 시트 일정 캠페인도 계획 INSERT 수행', CALLS.some(c => c.sql.includes('INSERT INTO campaign_daily_plans')));
  // 4f. 일정 판정 실패도 저장을 막지 않는다 — 조절은 저장한 날짜에 그대로 적용되므로
  //     잠그면 "조절할 방법이 없는" 막다른 길만 남는다(fail-closed 근거가 사라졌다).
  schedMod.deriveSchedules = async () => { throw new Error('boom'); };
  STUB = baseStub();
  const unkSaved = await P.savePlans('c1', { set: [{ date: d(1), count: 9 }] }, 't');
  eq('★ 일정 판정 실패해도 저장 가능', unkSaved.applied, 1);
  schedMod.deriveSchedules = async () => new Map();
  schedMod.scheduleFor = () => null;

  /* 4f-2. ★★ 조절을 저장하면 **오늘 이후 전체를 자동 재구성**한다(사용자 확정 2026-08-19).
     계기 = 「위프 800건」 — 8/20부터여야 할 스케줄이 26.8.26 으로 남아 있었다.
     종전 증분 동기화는 **이번에 저장한 날짜만** 손대서 과거·꼬인 빈 줄이 미래에 그대로 남는다. */
  {
    const sdp = require('../src/services/sheetlessDailyPlan.service');
    const led = require('../src/services/sheetlessLedger.service');
    const scope = require('../src/utils/sheetlessScope');
    const keep = {
      sync: sdp.syncAdjustedPlansToWorktable, defaults: sdp.loadWorktableDefaults,
      rebuild: sdp.rebuildAdjustedPlansToWorktable, ledgers: led.rebuildLedgers, isSheetless: scope.isSheetless,
      sheet: CAMP_ROW.linked_sheet_id, tab: CAMP_ROW.linked_tab_name,
    };
    CAMP_ROW.linked_sheet_id = 'wt_abc'; CAMP_ROW.linked_tab_name = '위프800';
    scope.isSheetless = async () => true;
    sdp.loadWorktableDefaults = async () => new Map();
    sdp.syncAdjustedPlansToWorktable = async () => ({ ok: true, moved: 1, cleared: 0 });
    led.rebuildLedgers = async () => ({ mirrorRows: 1, indexRows: 1, submittedCount: 0 });

    const planRows = [{ date: d(1), count: 20 }, { date: d(2), count: 20 }];
    const stubWithPlans = () => {
      const st = baseStub();
      st['FROM campaign_daily_plans'] = (sql) => ({ rows: /plan_date >=/.test(sql) ? planRows : [] });
      return st;
    };

    // ① 저장하면 재구성이 오늘 이후 계획 전체로 자동 실행된다
    let seen = null;
    sdp.rebuildAdjustedPlansToWorktable = async (a) => { seen = a; return { ok: true, reassigned: 3, cleared: 2, created: 0 }; };
    STUB = stubWithPlans(); CALLS.length = 0;
    let r = await P.savePlans('c1', { set: [{ date: d(1), count: 20 }] }, 'tester');
    ok('★★ 조절 저장 = 오늘 이후 전체 자동 재구성(사용자 확정 2026-08-19)', !!seen);
    ok('★ 재구성 대상은 오늘 이후 저장된 계획 전부(저장한 날짜만이 아니다)',
      seen && seen.plans.length === 2 && seen.today === today);
    ok('★ 재구성은 관리자 버튼과 같은 함수(사본 0)',
      /rebuildAdjustedPlansToWorktable/.test(readS('services/campaignPlan.service.js')));
    ok('★★ SAVEPOINT 격리(재구성 실패가 계획 저장을 죽이지 않는다)',
      /* ★ 부분일치로 보면 RELEASE/ROLLBACK TO 가 대신 통과시킨다(변이시험 실측) — 정확일치로 본다. */
      CALLS.some(c => c.sql.trim() === 'SAVEPOINT cp_auto_rebuild'));
    ok('★ 결과를 응답에 실어 화면이 말할 수 있다', !!(r.worktableSync && r.worktableSync.rebuild));

    // ② 재구성이 실패해도 계획 저장은 살아남는다(throw 없음 · ROLLBACK TO 만)
    sdp.rebuildAdjustedPlansToWorktable = async () => { const e = new Error('boom'); e.code = 'worktable_rebuild_below_used'; throw e; };
    STUB = stubWithPlans(); CALLS.length = 0;
    r = await P.savePlans('c1', { set: [{ date: d(1), count: 20 }] }, 'tester');
    eq('★★ 재구성 실패해도 계획 저장은 성공', r.applied, 1);
    ok('★ 실패는 사유로 드러난다(조용한 누락 금지)',
      r.worktableSync.rebuild.ok === false && r.worktableSync.rebuild.reason === 'worktable_rebuild_below_used');
    ok('★ 트랜잭션 전체가 아니라 SAVEPOINT 만 되돌린다',
      CALLS.some(c => c.sql.includes('ROLLBACK TO SAVEPOINT cp_auto_rebuild'))
      && !CALLS.some(c => c.sql.trim() === 'ROLLBACK'));
    ok('★ 화면이 재구성 실패를 말한다',
      /worktableSync\.rebuild/.test(readF('js/campaign-daily-plan.js'))
      && /worktable_rebuild_empty/.test(readF('js/campaign-daily-plan.js')));

    // ③ 킬스위치 = 종전 동작(증분 동기화만)
    seen = null;
    sdp.rebuildAdjustedPlansToWorktable = async (a) => { seen = a; return { ok: true }; };
    process.env.CAMPAIGN_PLAN_AUTO_REBUILD = '0';
    STUB = stubWithPlans();
    await P.savePlans('c1', { set: [{ date: d(1), count: 20 }] }, 'tester');
    ok('★ 킬스위치 CAMPAIGN_PLAN_AUTO_REBUILD=0 이면 자동 재구성 없음', seen === null);
    delete process.env.CAMPAIGN_PLAN_AUTO_REBUILD;

    sdp.syncAdjustedPlansToWorktable = keep.sync; sdp.loadWorktableDefaults = keep.defaults;
    sdp.rebuildAdjustedPlansToWorktable = keep.rebuild; led.rebuildLedgers = keep.ledgers;
    scope.isSheetless = keep.isSheetless;
    CAMP_ROW.linked_sheet_id = keep.sheet; CAMP_ROW.linked_tab_name = keep.tab;
    STUB = baseStub();
  }

  // 4g. 차수: 첫 추가 = 초도 흡수(1차 200) + 2차 100 → 총량 300 동기화
  STUB = baseStub();
  CALLS.length = 0;
  const r1 = await P.addRound('c1', { count: 100, startDate: d(1), label: '추가' }, 'tester');
  eq('첫 추가는 2차', r1.roundNo, 2);
  eq('총량 200→300 동기화', r1.newTotal, 300);
  eq('★ M1: 응답에 status 동봉(마감 영속 공고는 게시를 켜야 재개 — 화면 고지 재료)', r1.status, 'active');
  ok('초도(1차) 시드 INSERT', CALLS.some(c => c.sql.includes('INSERT INTO campaign_rounds') && c.sql.includes("'초도'")));
  ok('recruit_total UPDATE 실행', CALLS.some(c => c.sql.includes('SET recruit_total')));
  // 4h. 차수 제거 하한(확정+유효홀드 이하로 총량 못 내림 — Codex P1: 홀드는 정원 재검사 없이 확정된다)
  STUB = baseStub();
  STUB['FROM campaign_rounds'] = [
    { round_no: 1, slot_count: 200 }, { round_no: 2, slot_count: 100 },
  ];
  STUB['FROM campaign_applications'] = [{ submitted: 250, holds: 0, today_submitted: 0, today_holds: 0 }];
  await assert.rejects(P.removeLastRound('c1', 't'), (e) => e.code === 'below_confirmed');
  ok('★ 확정(250) 아래로 차수 제거 거부(below_confirmed)', true);
  STUB['FROM campaign_applications'] = [{ submitted: 150, holds: 60, today_submitted: 0, today_holds: 0 }];
  await assert.rejects(P.removeLastRound('c1', 't'), (e) => e.code === 'below_confirmed');
  ok('★ 유효 홀드 포함 하한(150+60 > 200) — 홀드는 confirmHoldInTx 가 정원 재검사 없이 확정', true);
  // 4i. 초도만 있으면 제거 불가
  STUB = baseStub();
  STUB['FROM campaign_rounds'] = [{ round_no: 1, slot_count: 200 }];
  await assert.rejects(P.removeLastRound('c1', 't'), (e) => e.code === 'no_round');
  ok('초도(1차)는 제거 불가(no_round)', true);

  // 4j. roundsLockRecruitTotal — fail-soft
  STUB = { 'FROM campaign_rounds': [{ '?column?': 1 }] };
  ok('차수 있으면 총모집 잠금 true', (await P.roundsLockRecruitTotal('c1')) === true);
  STUB = { 'FROM campaign_rounds': new Error('42P01류') };
  ok('★ 조회 실패 = 잠금 없음(기존 동작 — fail-soft)', (await P.roundsLockRecruitTotal('c1')) === false);
  // 4k. fetchRoundsSummary fail-soft
  STUB = { 'FROM campaign_rounds': new Error('down') };
  ok('차수 요약 실패 = 빈 Map(목록은 뜬다)', (await P.fetchRoundsSummary(poolMod, ['c1'])).size === 0);

  /* ═══════════════════════════════════════════════════════════
     5. 정적 가드 — 마이그레이션·라우트·배선
     ═══════════════════════════════════════════════════════════ */
  console.log('\n[5] 마이그레이션·라우트·배선');
  const mig = readM('095_campaign_daily_plans.sql');
  const mig018 = readM('018_campaigns.sql');
  ok('★ FK 타입 = 018 recruit_campaigns.id(TEXT)와 동일 — 42804(082 사고) 재발 차단',
    /id\s+TEXT\s+PRIMARY KEY/.test(mig018)
    && (mig.match(/campaign_id\s+TEXT NOT NULL REFERENCES recruit_campaigns\(id\) ON DELETE CASCADE/g) || []).length === 3);
  ok('UNIQUE(campaign_id, plan_date) — 같은 날 두 계획 불가', /UNIQUE \(campaign_id, plan_date\)/.test(mig));
  ok('UNIQUE(campaign_id, round_no)', /UNIQUE \(campaign_id, round_no\)/.test(mig));
  ok('planned_count CHECK >= 0', /planned_count INT\s+NOT NULL CHECK \(planned_count >= 0\)/.test(mig));
  ok('IF NOT EXISTS(재실행 안전)', (mig.match(/CREATE TABLE IF NOT EXISTS/g) || []).length === 3);

  const st = readS('services/campaignState.service.js');
  ok('킬스위치 CAMPAIGN_DAILY_PLAN', /process\.env\.CAMPAIGN_DAILY_PLAN !== '0'/.test(st));
  ok('★ 기존 이월 불변식 ①(비조절일 축소 금지) 생존', /if \(q < dl\) q = dl;/.test(st));
  ok('★ 총량 clamp 생존', /Math\.min\(q, rt - before\)/.test(st));
  ok('계획 로더 SAVEPOINT 격리(082 규율)', /SAVEPOINT cdp_plans/.test(st) && /ROLLBACK TO SAVEPOINT cdp_plans/.test(st));
  ok('42P01 네거티브 캐시', /_planTableMissingAt/.test(st));
  const mig139 = readM('139_campaign_carry_strategy.sql');
  const ir = readF('js/index-recruit.js');
  const cdp = readF('js/campaign-daily-plan.js');
  const routeSrc = readS('routes/campaign.routes.js');
  ok('139 전략 컬럼은 재실행 안전하게 추가',
    /ADD COLUMN IF NOT EXISTS carry_strategy TEXT DEFAULT 'next'/.test(mig139));
  ok('139 전략은 보류(carry_mode)와 별도이며 서버가 next|spread|extend만 해석',
    /function carryStrategy\(c\)/.test(st)
    && /new Set\(\['next', 'spread', 'extend'\]\)/.test(st)
    && /strategy !== 'extend'/.test(st));
  ok('139 신규 공고 설정은 전략을 저장하고 편집 시 서버값을 복원',
    /payload\.carry_strategy/.test(ir)
    && /c\.carry_strategy/.test(ir)
    && !/localStorage\.getItem\("rf_carry_strategy_v1_"/.test(ir));
  ok('139 생성·수정·공개 목록이 전략을 같은 값으로 전달',
    /carry_mode, carry_strategy, skip_weekends/.test(routeSrc)
    && /carry_strategy = COALESCE\(\$49, carry_strategy\)/.test(routeSrc)
    && /carry_strategy, work_kind, skip_weekends/.test(routeSrc));
  ok('139 공개 카드 응답 화이트리스트도 전략을 전달',
    /PUBLIC_FIELDS_LEGACY[\s\S]*'carry_strategy'/.test(routeSrc)
    && /PUBLIC_FIELDS_PARTICIPATION[\s\S]*'carry_strategy'/.test(routeSrc));
  ok('139 날짜별 조절 모달도 서버 저장 전략을 우선 사용',
    /S\.carryMode \|\| j\.carryStrategy \|\| _loadMode\(\) \|\| DEFAULT_CARRY_MODE/.test(cdp)
    && /carryStrategy: carryStrategy\(camp\)/.test(readS('services/campaignPlan.service.js')));

  // 라우터 스택 실검사(문자열 grep 이 아니라 실제 등록 확인)
  const trackB = require('../src/routes/trackB.routes');
  const layers = trackB.stack.filter(l => l.route).map(l => ({
    path: l.route.path, methods: Object.keys(l.route.methods), count: l.route.stack.length,
  }));
  const find = (p, m) => layers.find(l => l.path === p && l.methods.includes(m));
  for (const [p, m] of [
    ['/campaigns/:id/daily-plan', 'get'], ['/campaigns/:id/daily-plan', 'post'],
    ['/campaigns/:id/rounds', 'post'], ['/campaigns/:id/rounds', 'delete'],
  ]) {
    const l = find(p, m);
    ok(`라우트 ${m.toUpperCase()} ${p} 등록 + 미들웨어 체인(auth→internal→핸들러)`, l && l.count >= 3);
  }
  const rtB = readS('routes/trackB.routes.js');
  ok('42P01 → not_ready(migration 095 안내)', /not_ready.*migration 095/.test(rtB));
  ok('below_used 는 422 + floor 동봉', /below_used: 422/.test(rtB) && /floor: err\.floor/.test(rtB));

  const rt = readS('routes/campaign.routes.js');
  ok('★ PUT 수정이 차수 공고의 recruit_total 을 무시(총량 보호)',
    (rt.match(/roundsLockRecruitTotal/g) || []).length >= 2 && /_rtEff = null/.test(rt));
  ok('★ M2: 무시했음을 응답이 말한다(recruitTotalLocked — 조용한 누락 금지)',
    /recruitTotalLocked: true/.test(rt) && /recruitTotalLocked/.test(readF('js/index-recruit.js')));
  ok('★ Codex P1: 잠금 검사↔UPDATE 경합 자가치유(repair — PUT·스코프 편집 양쪽)',
    (rt.match(/repairRecruitTotalFromRounds/g) || []).length >= 2
    && /IS DISTINCT FROM s\.total/.test(readS('services/campaignPlan.service.js')));
  ok('★ m4: 조절값 판정 단일 출처(planOverrideFor — dailyQuota·표시 공용)',
    /function planOverrideFor/.test(st) && /planOverrideFor\(counts\.plans \|\| null, todayStr\)/.test(st)
    && /const ov = planOverrideFor\(plans, todayStr\)/.test(st));
  ok('★ 무시트 작업표 조절 저장은 원장·작업보드 투영까지 재생성',
    /isSheetless\(client, camp\.linked_sheet_id, camp\.linked_tab_name\)/.test(readS('services/campaignPlan.service.js'))
    && /rebuildLedgers\(\{ \.\.\.projectionTarget/.test(readS('services/campaignPlan.service.js'))
    && /worktableProjection/.test(readS('services/campaignPlan.service.js')));
  ok('★ 기본으로(remove)도 작업표 원장에 기본값을 적용하고 투영을 재생성',
    /\(set\.length \|\| remove\.length\)/.test(readS('services/campaignPlan.service.js'))
    && /loadWorktableDefaults/.test(readS('services/campaignPlan.service.js'))
    && /remove\.map\(date => \(\{ date, count: defaults\.get\(date\) \}\)\)/.test(readS('services/campaignPlan.service.js')));
  ok('★ 투영 재생성 실패는 성공으로 숨기지 않고 같은 저장으로 재시도 가능',
    /worktable_projection_failed/.test(readS('services/campaignPlan.service.js'))
    && /worktable_projection_failed: 503/.test(rtB));
  ok('admin/list 가 rounds·todayPlanned·planAdjusted 를 내려준다',
    /fetchRoundsSummary/.test(rt) && /todayPlanned: st\.todayPlanned/.test(rt) && /planAdjusted: st\.planAdjusted === true/.test(rt));

  // 프론트 배선
  const cards = readF('js/campaign-cards.js');
  ok('카드 [📅 인원] 버튼 — 참여형 + 모듈 존재 게이트',
    /c\.participation_mode && typeof window !== 'undefined' && window\.CampaignDailyPlan/.test(cards)
    && /CampaignDailyPlan\.open\('\$\{id\}'\)/.test(cards));
  ok('카드 "조절" 칩(planAdjusted — 이월로 위장 금지)', /pg-plan/.test(cards) && /c\.planAdjusted === true/.test(cards));
  // ★★ 오늘 정원 0인 카드도 칩(이월·조절·보류)을 그린다 — 종전엔 자리표시자가 통째로 덮어써
  //   휴무일·일정종료 공고의 이월이 화면 어디에도 없었다(사용자 신고 2026-08-07).
  ok('★ 칩은 게이지 분기 밖에서 만든다(정원 0 카드에서도 표시)',
    /const chips = `\$\{tqChip\}\$\{holdTip\}\$\{planTip\}\$\{carryTip\}`;/.test(cards)
    && (cards.match(/\$\{chips\}/g) || []).length >= 2);
  ok('★ 정원 0 사유를 사실대로(게시된 공고를 "게시 전"으로 위장 금지)',
    /function _zeroQuotaNote\(c, isPre, isDraft\)/.test(cards)
    && /stateReason === 'rest_day'/.test(cards) && /오늘 휴무/.test(cards)
    && /schedule_ended/.test(cards) && /soft_full/.test(cards));
  ok('★ 오픈 전·게시 전은 칩 미표시(없는 숫자 표시 금지)',
    /const showChips = !isPre && !isDraft;/.test(cards));
  ok('카드 차수 줄(_roundsLine — 2차 이상일 때만)', /_roundsLine/.test(cards) && /rs\.length < 2\) return ''/.test(cards));
  const modal = readF('js/campaign-daily-plan.js');
  ok('모달 경로 = /api/trackb/* 공용(재기준 불필요)', /'\/api\/trackb\/campaigns\/'/.test(modal));
  ok('★ 질문은 조절 한 묶음당 한 번(디바운스)', /SETTLE_MS = 700/.test(modal) && /scheduleSettle/.test(modal));
  ok('★ 분산 범위 = 축소 전 종료일까지(시안 실측 규칙)', /prevEnd/.test(modal) && /untilN/.test(modal));
  ok('확정 저장은 브라우저 confirm 없이 즉시 요청한다',
    !/window\.confirm\('아래 조절을 저장할까요/.test(modal)
    && /즉시 저장한 뒤/.test(modal));
  ok('마운트 body 직속', /document\.body\.appendChild/.test(modal));
  ok('★ onclick 에 서버 문자열 보간 없음(XSS 규율)', !/onclick="[^"]*\$\{/.test(modal));
  // ★★ 시트 일정 공고도 조절 가능 — 읽기 전용 잠금이 되살아나면 실패한다(사용자 확정 2026-08-07)
  ok('★ 시트 일정 공고 읽기 전용 잠금 부재(조절 허용)',
    !/여기서는 조절할 수 없습니다/.test(modal) && !/시트 일정 캠페인 — 읽기 전용/.test(modal));
  ok('★ 시트 계획을 기준선으로 표시(baseFor/sheetFor 단일 출처) + 규칙 안내',
    /function sheetFor\(d\)/.test(modal) && /function baseFor\(d\)/.test(modal)
    && /S\.data\.scheduleDriven === true\) return sheetFor\(d\);/.test(modal)
    && /function worktableFor\(d\)/.test(modal)
    && /여기서 조절한 날짜만 시스템 값이 우선/.test(modal));
  ok('★ 시트 일정 공고는 보류 미적용을 사유로 말한다(조회 실패로 뭉뚱그리지 않는다)',
    /이월 보류 설정이 적용되지 않습니다/.test(modal)
    && /시트 일정 공고에는 이월 보류가 적용되지 않습니다/.test(modal));
  // ★★ 코드리뷰 #3 — "기본" 판정이 baseFor 단일 출처를 지켜야 한다. defaultDaily 로 비교하면
  //   ① 시트 15인 날을 20(=daily_limit)으로 올릴 때 조절이 조용히 삭제되고(setPlan)
  //   ② 시트 30인 날을 22로 줄여도 축소 질문이 안 뜬다(settle).
  ok('★ setPlan/settle/기본으로/눈금선이 baseFor 를 쓴다(defaultDaily 사본 금지)',
    /if \(v === baseFor\(d\) && S\.base\[d\] == null\) delete S\.plan\[d\];/.test(modal)
    && /var dl = baseFor\(d\);/.test(modal)
    && /commitValue\(d2, baseFor\(d2\)\)/.test(modal)
    && /baseFor\(d\) \/ scale \* 100/.test(modal));
  ok('★ 코드리뷰 #4: 총량·예상 종료일이 시트 총량(scheduleTotal)을 본다',
    /function totalFor\(\)/.test(modal) && /S\.data\.scheduleTotal/.test(modal)
    && /var total = totalFor\(\);/.test(modal)
    && /scheduleTotal:/.test(readS('services/campaignPlan.service.js')));
  ok('★ 코드리뷰 #5: 카드 "기본" 툴팁이 todayBaseline(시트 공고 = 시트 행 수)을 쓴다',
    /c\.todayBaseline != null\) \? Number\(c\.todayBaseline\)/.test(cards)
    && /todayBaseline: st\.todayBaseline/.test(readS('routes/campaign.routes.js')));
  ok('★ 코드리뷰 #2: savePlans 잔량 재검증도 heldCarry 에 schedule 을 넘긴다(판정 단일 출처)',
    /heldCarry\(camp, counts, today, sums\.get\(campaignId\) \|\| 0, schedule\)/.test(readS('services/campaignPlan.service.js')));
  ok('킬스위치 안내(저장 잠금)', /CAMPAIGN_DAILY_PLAN=0/.test(modal));
  ok('★ M1: 마감·임시저장 배너 + 차수 추가 토스트("게시를 켜야 모집이 재개")',
    /게시 토글을 켜야/.test(modal) && /게시를 켜야 모집이 재개됩니다/.test(modal));
  ok('★ m1: 모달 닫은 뒤 디바운스 타이머 가드(if (!S || !S.data) return)',
    /function settle\(d\) \{\s*\n\s*if \(!S \|\| !S\.data\) return;/.test(modal));
  ok('★ m6: 분산 일수 상한(서버 120일 상한 선반영)', /untilN > 110/.test(modal));
  ok('★ Codex P2: 투영·행 기준일 = max(오늘, 시작일) — 오픈 전 날짜 소진 오표시 차단',
    /function baseDate\(\)/.test(modal) && /sd > S\.data\.today\) \? sd : S\.data\.today/.test(modal));
  ok('admin.html 에 모듈 로드', /campaign-daily-plan\.js/.test(readF('admin.html')));
  ok('workdesk.html 에 모듈 로드', /campaign-daily-plan\.js/.test(readF('workdesk.html')));
  const workdesk = readF('workdesk.html');
  ok('★ 작업보드 [모집인원 조절]도 공용 모달만 연다(별도 스케줄 저장 경로 금지)',
    /function openCurrentCampaignDailyPlan\(\)/.test(workdesk)
    && /CampaignDailyPlan\.open\(String\(cs\[0\]\.id\)\)/.test(workdesk)
    && /📅 모집인원 조절/.test(workdesk));
  ok('★ 공용 모달 저장 후 열린 작업보드를 재조회해 작업표 투영 결과를 표시',
    /CAMPAIGN_DAILY_PLAN_SAVED/.test(modal)
    && /window\.CAMPAIGN_DAILY_PLAN_SAVED=function/.test(workdesk)
    && /selTab\(i,\{nav:true\}\)/.test(workdesk));

  /* ═══════════════════════════════════════════════════════════
     6. 진짜 PG (PGTEST_URL 있을 때만) — 마이그레이션·유니크·CASCADE
     ═══════════════════════════════════════════════════════════ */
  if (process.env.PGTEST_URL) {
    console.log('\n[6] 진짜 PG 검증');
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS recruit_campaigns (id TEXT PRIMARY KEY, title TEXT)`);
      const sql = mig;
      await c.query(sql);
      await c.query(sql);   // idempotent(재실행 안전)
      await c.query(mig139);
      await c.query(mig139); // 전략 컬럼도 재실행 안전
      ok('마이그레이션 2회 적용 무사(idempotent)', true);
      const { rows: strategyColumn } = await c.query(`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recruit_campaigns'
          AND column_name = 'carry_strategy'
      `);
      ok('이월 전략 컬럼 생성 + 기존 공고 기본값 next',
        strategyColumn.length === 1 && String(strategyColumn[0].column_default || '').includes("'next'"));
      await c.query(`INSERT INTO recruit_campaigns (id, title) VALUES ('t1','x') ON CONFLICT DO NOTHING`);
      await c.query(`DELETE FROM campaign_daily_plans WHERE campaign_id='t1'`);
      await c.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count) VALUES ('t1','2026-08-10',20)`);
      let dup = false;
      try { await c.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count) VALUES ('t1','2026-08-10',30)`); }
      catch (e) { dup = e.code === '23505'; }
      ok('같은 날 두 계획 = 23505(UNIQUE)', dup);
      let neg = false;
      try { await c.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count) VALUES ('t1','2026-08-11',-1)`); }
      catch (e) { neg = e.code === '23514'; }
      ok('음수 인원 = 23514(CHECK)', neg);
      await c.query(`DELETE FROM recruit_campaigns WHERE id='t1'`);
      const { rows } = await c.query(`SELECT COUNT(*) AS n FROM campaign_daily_plans WHERE campaign_id='t1'`);
      ok('캠페인 삭제 시 계획 CASCADE', Number(rows[0].n) === 0);
    } finally { await c.end(); }
  } else {
    console.log('\n[6] PGTEST_URL 미지정 — 진짜 PG 검증 생략');
  }

  /* ═══════════════════════════════════════════════════════════
     7. 균형 모드 — 총량 안에서만 조절 + 이월 보충 투입 방식 (요구 ①②③④⑥)
        시안 = frontend/docs/design-recruit-quota-balance.html (사용자 확정).
        ★ grep 만으로는 산수를 못 본다 → 엔진 블록을 vm 으로 꺼내 **실제로 실행**한다.
     ═══════════════════════════════════════════════════════════ */
  console.log('\n[7] 균형 모드(요구 ①②③④⑥)');
  const vm = require('vm');
  const cdpSrc = readF('js/campaign-daily-plan.js');

  // 소스에서 필요한 두 구간을 잘라 sandbox 에서 실행한다(테스트용 export 를 제품에 심지 않는다)
  const slice = (from, to, label) => {
    const a = cdpSrc.indexOf(from), b = cdpSrc.indexOf(to);
    assert(a >= 0 && b > a, `${label} 구간 마커를 찾지 못했습니다(배선 변경 시 마커도 갱신할 것)`);
    return cdpSrc.slice(a, b);
  };
  const partDate = slice('  var DOW =', '  /* ── 마운트(body 직속)', '날짜·기준선 유틸');
  const partBal = slice('  var MAX_ROWS = 120;', '  /** 예상 종료일:', '균형 엔진');
  // payload() 는 렌더 근처에 있어 따로 잘라 붙인다(저장 게이트와 저장 본문의 단일 출처)
  const partPay = slice('  /** 균형 모드의 저장 payload', '  /* ── 렌더 ─', '저장 payload');

  const sandbox = { S: null, console, renders: 0 };
  sandbox.render = () => { sandbox.renders++; };
  vm.createContext(sandbox);
  vm.runInContext(partDate + '\n' + partBal + '\n' + partPay
    // 엔진이 부르는 바깥 함수(행 하한) — 오늘은 확정·진행 인원 아래로 못 줄인다
    + '\nfunction minFor(d){ return d === S.data.today ? (S.data.todayUsed || 0) : 0; }'
    + '\nthis.api = { walkDays, buildHorizon, applyCarryMode, carryOn, carryPlaced, carryDays,'
    + ' autoFit, maxFor, dayCeil, sumPlan, diffPlan, targetTotal, doneBefore, changedFromOpen, effBase, planFor,'
    + ' payload, naturalFor, carryAmt, CARRY_MODES, MAX_ROWS, MAX_DAY,'
    + ' holidayName, dayKind, fmtMD, FIXED_HOLIDAYS, LUNAR_HOLIDAYS, DEFAULT_CARRY_MODE };',
    sandbox);
  const A = sandbox.api;

  const mkS = (patch) => {
    sandbox.S = {
      data: Object.assign({
        today: '2026-08-08', startDate: '2026-08-01', defaultDaily: 40, recruitTotal: 800,
        scheduleDriven: false, scheduleDates: null, scheduleTotal: null,
        submittedAll: 55, todaySubmitted: 5, byDateSubmitted: { '2026-08-08': 5 },
        todayUsed: 5, carryPending: 30, carryMode: 'auto', planEnabled: true,
        // 서버(computeCampaignState)가 준 "손대지 않으면 오늘 열리는 정원"
        todayNaturalQuota: 70,
      }, (patch && patch.data) || {}),
      plan: {}, base: (patch && patch.base) || {}, notes: [], sessions: {},
      balance: false, horiz: null, carryMap: null, openPlan: null, modePlan: null,
    };
    return sandbox.S;
  };

  // 7a. 배분해야 할 인원 = 총량 − 어제까지 확정(오늘 확정은 오늘 줄 안에 있다)
  mkS();
  eq('7a 어제까지 확정 = 전체 55 − 오늘 5', A.doneBefore(), 50);
  eq('7a 남은 배분수 = 800 − 50', A.targetTotal(), 750);

  // 7b. 기본 방식(다음날에 더하기) — 이월 전액이 첫 진행일, 합계는 정확히 목표
  mkS();
  ok('7b 기본 방식 펼치기 성공', A.applyCarryMode('next') === true);
  eq('7b 구간 길이', sandbox.S.horiz.length, 18);
  eq('7b 첫 진행일 = 기본 40 + 이월 30', sandbox.S.plan['2026-08-08'], 70);
  eq('7b 첫 진행일 이월 배정', A.carryOn('2026-08-08'), 30);
  eq('7b 배분 합계 ≡ 남은 배분수', A.sumPlan(), 750);
  eq('7b 균형 = 0', A.diffPlan(), 0);
  eq('7b 얹힌 이월 합계', A.carryPlaced(), 30);

  // 7c. ★ 이월이 얹힌 총합은 어느 방식에서도 이월 인원과 같다(잘려서 29가 되면 안 된다 — 시안 실측)
  mkS();
  A.applyCarryMode('spread');
  eq('7c 나눠 담기 — 얹힌 이월 합계', A.carryPlaced(), 30);
  eq('7c 나눠 담기 — 배분 합계 유지', A.sumPlan(), 750);
  ok('7c 나눠 담기는 여러 날에 걸친다', A.carryDays().length > 1);

  // 7d. 종료일 뒤에 붙이기 = 어느 날에도 얹지 않고 구간이 하루 늘어난다
  mkS();
  A.applyCarryMode('extend');
  eq('7d 연장 — 얹힌 이월 0', A.carryPlaced(), 0);
  eq('7d 연장 — 구간 하루 증가', sandbox.S.horiz.length, 19);
  eq('7d 연장 — 마지막 날은 남은 만큼만', sandbox.S.plan[sandbox.S.horiz[18]], 30);
  eq('7d 연장 — 배분 합계 유지', A.sumPlan(), 750);

  /* 7e. ★★ 사용자 확정 2026-08-19: 합계가 총건수를 넘는 조절은 **경고가 아니라 차단**이다.
     한 날 상한 = 그 날 값 + 아직 남은 배분수 → 게이지·[＋]·숫자입력 어느 쪽으로도 총량을
     넘기는 값 자체가 들어가지 않는다(종전에는 한 날에 750 까지 넣고 "초과 — 저장불가"였다). */
  mkS();
  A.applyCarryMode('next');
  const d7e = sandbox.S.horiz[1];
  eq('7e 합계가 딱 맞으면 상한 = 그 날 값(더 못 올린다)', A.maxFor(d7e), A.planFor(d7e));
  eq('7e 절대 상한(autoFit 용)은 종전 의미 — 배분해야 할 인원', A.dayCeil(), 750);
  sandbox.S.plan[d7e] = A.planFor(d7e) - 3;      // 3명 줄여 여유를 만든다
  eq('7e 3명 줄이면 그만큼만 다시 열린다', A.maxFor(d7e), A.planFor(d7e) + 3);
  eq('7e 여유는 다른 날에도 같은 크기로 열린다', A.maxFor(sandbox.S.horiz[2]), A.planFor(sandbox.S.horiz[2]) + 3);
  // ★ 이미 초과 상태(작업표 프리필이 총량을 안 보고 심은 계획 등)로 열려도 **줄이는 길은 남긴다**
  mkS(); A.applyCarryMode('next');
  const dOver = sandbox.S.horiz[0];
  sandbox.S.plan[dOver] = A.planFor(dOver) + 50;   // 강제로 초과 상태를 만든다
  ok('7e 초과 상태 = 상한이 현재값(늘리기만 막힌다)', A.maxFor(dOver) === A.planFor(dOver) && A.diffPlan() > 0);
  ok('7e 초과 상태에서도 줄이기는 막지 않는다(하한은 오늘 확정분뿐)', A.maxFor(dOver) > 0);
  // ★ 오늘 하한(확정·진행 인원)이 상한보다 크면 하한이 이긴다(음수·역전 방지)
  mkS({ data: { todayUsed: 999 } }); A.applyCarryMode('next');
  ok('7e 오늘 하한이 상한을 넘어서지 않는다', A.maxFor('2026-08-08') >= 999);

  // 7f. ★★ 요구 ⑥ — 초과/부족을 만들고 [자동 맞춤]이 고른 방식대로 되돌린다
  for (const mode of ['next', 'spread', 'extend']) {
    mkS(); A.applyCarryMode(mode);
    sandbox.S.plan['2026-08-09'] = sandbox.S.plan['2026-08-09'] + 6;
    eq(`7f(${mode}) 늘리면 초과로 잡힌다`, A.diffPlan(), 6);
    A.autoFit();
    eq(`7f(${mode}) 자동 맞춤 후 균형`, A.diffPlan(), 0);
    mkS(); A.applyCarryMode(mode);
    sandbox.S.plan['2026-08-09'] = sandbox.S.plan['2026-08-09'] - 6;
    eq(`7f(${mode}) 줄이면 부족으로 잡힌다`, A.diffPlan(), -6);
    A.autoFit();
    eq(`7f(${mode}) 자동 맞춤 후 균형`, A.diffPlan(), 0);
  }
  // ★★ 자동 맞춤은 "고른 방식대로" 메운다 — 균형만 맞으면 아무 날에나 넣어도 되는 게 아니다
  {
    mkS(); A.applyCarryMode('next');
    const first = sandbox.S.horiz[0], last = sandbox.S.horiz[sandbox.S.horiz.length - 1];
    const f0 = A.planFor(first), l0 = A.planFor(last);
    sandbox.S.plan['2026-08-09'] -= 6;
    A.autoFit();
    eq('7f ★ 다음날에 더하기 = 부족분이 가장 이른 진행일로', A.planFor(first), f0 + 6);
    eq('7f ★ 다음날에 더하기 = 마지막 날은 그대로', A.planFor(last), l0);
  }
  {
    mkS(); A.applyCarryMode('spread');
    const snap = Object.assign({}, sandbox.S.plan);
    sandbox.S.plan['2026-08-09'] -= 6;
    A.autoFit();
    const moved = sandbox.S.horiz.filter((x) => x !== '2026-08-09' && A.planFor(x) !== snap[x]);
    ok('7f ★ 나눠 담기 = 여러 날에 흩어 메운다(한 날에 몰지 않는다)', moved.length >= 2);
  }

  // 7f-1. 종료일 뒤 자동 채우기: 마지막 부분일을 기본 일건수까지 채운 뒤, 다음 0명 날짜를 연다.
  // 44건 부족이면 15→35(+20), 다음 날 +24가 되어 정확히 44건만 반영되어야 한다.
  mkS({ data: { today: '2026-09-12', startDate: '2026-09-12', defaultDaily: 35, recruitTotal: 170,
    submittedAll: 61, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0, todayNaturalQuota: 35 } });
  sandbox.S.balance = true; sandbox.S.carryMode = 'extend';
  sandbox.S.horiz = ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15'];
  sandbox.S.plan = { '2026-09-12': 15, '2026-09-13': 35, '2026-09-14': 15, '2026-09-15': 0 };
  eq('7f-1 종료일 연장 전 부족분 = 44', A.diffPlan(), -44);
  A.autoFit();
  eq('7f-1 마지막 부분일은 기본 일건수까지 채움(15→35)', A.planFor('2026-09-14'), 35);
  eq('7f-1 다음 날짜에는 남은 수량만 채움(+24)', A.planFor('2026-09-15'), 24);
  eq('7f-1 오늘에 줄여 둔 수량은 건드리지 않는다', A.planFor('2026-09-12'), 15);
  eq('7f-1 자동 채움 후 균형', A.diffPlan(), 0);

  // 7g. ★★ "종료일 뒤에 붙이기"에서 줄인 몫은 **마지막 날에 쌓이지 않고 종료일이 밀린다**
  //     (마지막 날에 쌓으면 고른 방식과 정반대가 된다 — 변이시험이 잡은 실제 버그)
  mkS(); A.applyCarryMode('extend');
  const daysBefore = sandbox.S.horiz.length;
  const lastBefore = sandbox.S.horiz[daysBefore - 1];
  const lastPlanBefore = A.planFor(lastBefore);
  sandbox.S.plan['2026-08-08'] = 5;                     // 오늘을 하한까지 줄인다(−35)
  eq('7g 줄이면 부족 −35', A.diffPlan(), -35);
  A.autoFit();
  eq('7g 자동 맞춤 후 균형(총량 보존)', A.diffPlan(), 0);
  ok('7g ★ 기존 마지막 날에 몰아주지 않았다',
    A.planFor(lastBefore) <= Math.max(lastPlanBefore, A.effBase(lastBefore)));
  ok('7g 추가된 날은 기준선을 넘지 않는다', A.planFor(sandbox.S.horiz[sandbox.S.horiz.length - 1]) <= 40);

  // 7h. ★★ 오늘은 확정·진행 인원 아래로 잡히지 않는다 — 저장된 조절이 그 사이 늘어난 확정보다
  //     작아도 마찬가지(그대로 보내면 서버가 below_used 로 거절해 막다른 길이 된다)
  mkS({ base: { '2026-08-08': 2 } });                   // 저장된 조절 2 < 오늘 확정·진행 5
  A.applyCarryMode('extend');
  ok('7h ★ 오늘 하한(확정·진행 5) 유지', sandbox.S.plan['2026-08-08'] >= 5);
  mkS(); A.applyCarryMode('next');
  sandbox.S.plan['2026-08-08'] = 500;                   // 크게 초과시켜 자동 맞춤이 뒤에서 덜어내게 한다
  A.autoFit();
  ok('7h 자동 맞춤도 하한을 지킨다', sandbox.S.plan['2026-08-08'] >= 5);
  eq('7h 자동 맞춤 후 균형', A.diffPlan(), 0);
  ok('7h ★ 자동 맞춤은 minFor 를 하한으로 쓴다(0 까지 깎지 않는다)',
    /var cut = Math\.min\(planFor\(d2\) - minFor\(d2\), -need\);/.test(cdpSrc));

  // 7i. ★★ 저장된 조절은 모달을 열어도 덮이지 않는다(출발선 = effBase)
  mkS({ base: { '2026-08-12': 5 } });
  A.applyCarryMode('next');
  eq('7i 저장된 조절이 출발선', A.planFor('2026-08-12'), 5);
  eq('7i 저장된 조절은 effBase', A.effBase('2026-08-12'), 5);
  eq('7i 합계는 여전히 목표', A.sumPlan(), 750);

  // 7i-2. 첫 진행일의 저장값은 이미 실제 정원이다. 재오픈 때 pending carry를 다시
  // 얹으면 카드의 81명과 모달의 121명이 갈린다.
  mkS({ base: { '2026-08-08': 81, '2026-08-09': 39 } });
  A.applyCarryMode('next');
  eq('7i-2 재오픈한 오늘은 저장한 실제 정원 그대로', A.planFor('2026-08-08'), 81);
  eq('7i-2 저장된 첫날에는 이월을 중복 배치하지 않는다', A.carryOn('2026-08-08'), 0);
  eq('7i-2 재오픈해도 총량 균형 유지', A.sumPlan(), 750);

  // 7j. ★ 시트 일정 공고 — 휴무일도 0명 조절행으로 보여야 주말 증원이 가능하고, 총량은 시트 행 수
  {
    const dates = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(2026, 7, 8 + i)).toISOString().slice(0, 10);
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      dates.push({ date: d, slots: (wd === 0 || wd === 6) ? 0 : 20 });
    }
    mkS({ data: {
      scheduleDriven: true, scheduleDates: dates, scheduleTotal: 160, recruitTotal: 160,
      defaultDaily: 20, submittedAll: 25, todaySubmitted: 5, byDateSubmitted: { '2026-08-08': 5 },
      todayUsed: 5, carryPending: 10, todayNaturalQuota: 20,
    } });
    ok('7j 시트 일정 공고도 균형 모드', A.applyCarryMode('next') === true);
    eq('7j 총량 = 시트 행 수 기준 남은 배분수', A.targetTotal(), 140);
    eq('7j 배분 합계 ≡ 목표', A.sumPlan(), 140);
    ok('7j 휴무일도 0명 조절행으로 남는다', sandbox.S.horiz.some((d) => A.planFor(d) === 0));
  }

  // 7k. ★★ 균형 모드 불가 조건 = 조용히 반쪽으로 켜지 않고 **꺼진다**(종전 동작 유지)
  mkS({ data: { recruitTotal: 0, scheduleTotal: null } });
  ok('7k 무제한 총량 = 균형 모드 꺼짐', A.applyCarryMode('next') === false && sandbox.S.balance === false);
  mkS({ data: { recruitTotal: 900000 } });
  ok('7k 구간이 저장 상한(120일)을 넘으면 꺼짐', A.applyCarryMode('next') === false);
  mkS({ data: { defaultDaily: 0 } });
  ok('7k 하루 정원 0 = 채울 수 없어 꺼짐', A.applyCarryMode('next') === false);

  // 7k-2. 이미 총량을 채운 공고 = 배분할 인원 0 → 균형 개념이 없어 꺼진다
  mkS({ data: { submittedAll: 800, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0 } });
  eq('7k 총량 충족 = 배분할 인원 0', A.targetTotal(), 0);
  ok('7k 총량 충족 = 균형 모드 꺼짐', A.applyCarryMode('next') === false);

  // 7k-3. 오픈 전(시작일이 미래) — 오늘이 아니라 **시작일부터** 펼친다(오픈 전 날짜 조절은 무의미)
  mkS({ data: { startDate: '2026-08-20', submittedAll: 0, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0 } });
  A.applyCarryMode('next');
  eq('7k 오픈 전 = 시작일이 첫 줄', sandbox.S.horiz[0], '2026-08-20');
  eq('7k 오픈 전 = 합계는 총량 전체', A.sumPlan(), 800);

  // 7l. ★ 이월 계산 불가(null)는 0 으로 꾸미지 않는다 — 얹을 것이 없을 뿐 구간은 펼친다
  mkS({ data: { carryPending: null, todayNaturalQuota: 40 } });
  ok('7l 이월 null 이어도 구간은 펼친다', A.applyCarryMode('next') === true);
  eq('7l 이월 null = 얹힌 이월 0', A.carryPlaced(), 0);
  eq('7l 이월 null = 합계는 목표', A.sumPlan(), 750);

  // 7m. 「변경 있음」 판정 — 열었을 때 대비(닫기 확인용). 방식 전환은 변경으로 센다
  mkS(); A.applyCarryMode('next');
  ok('7m 열자마자는 변경 없음', A.changedFromOpen() === false);
  A.applyCarryMode('extend');
  ok('7m 방식 전환 = 변경 있음', A.changedFromOpen() === true);

  /* ── 7A. 코드리뷰 반영 6종(완화 금지) ─────────────────────────────── */
  console.log('\n[7A] 코드리뷰 반영 — 막다른 길·불필요한 고정·유령 이월 차단');

  // 7A-1 ★★ 오늘 하한 > 배분 목표 = 균형 모드를 켜지 않는다
  //   (켜면 균형 바가 영원히 "초과 — 저장불가"이고 [자동 맞춤]은 하한에 막혀 죽은 버튼이 된다)
  mkS({ data: { submittedAll: 800, todaySubmitted: 2, byDateSubmitted: { '2026-08-08': 2 }, todayUsed: 40 } });
  ok('7A-1 오늘 하한 > 배분 목표 = 균형 모드 꺼짐(막다른 길 방지)',
    A.targetTotal() < 40 && A.applyCarryMode('next') === false, A.targetTotal());

  // 7A-2 ★★ 손대지 않은 날은 저장하지 않는다 — 시트 일정 공고의 시트 우선권이 사라지면 안 된다
  {
    const dates = [];
    for (let i = 0; i < 14; i++) dates.push({ date: new Date(Date.UTC(2026, 7, 8 + i)).toISOString().slice(0, 10), slots: 20 });
    mkS({ data: {
      scheduleDriven: true, scheduleDates: dates, scheduleTotal: 280, recruitTotal: 280, defaultDaily: 20,
      submittedAll: 25, todaySubmitted: 5, byDateSubmitted: { '2026-08-08': 5 }, todayUsed: 5, carryPending: null,
      todayNaturalQuota: 20,
    } });
    A.applyCarryMode('next');
    const pl = A.payload();
    eq('7A-2 시트 일정 공고를 손대지 않으면 set 0(시트 우선권 유지)', pl.set.length, 0);
    eq('7A-2 remove 도 0(저장된 조절 미삭제)', pl.remove.length, 0);
    sandbox.S.plan['2026-08-11'] = 30;
    const pl2 = A.payload();
    eq('7A-2 손댄 날만 보낸다', pl2.set.length, 1);
    eq('7A-2 보낸 날짜', pl2.set[0].date, '2026-08-11');
  }

  // 7A-3 ★★ 자동 이월 공고의 "다음날에 더하기" = 서버가 이미 하는 일 → 보낼 것 없음.
  //   반대로 "종료일 뒤에 붙이기"는 그 자동 가산을 억제해야 하므로 오늘을 기본값으로 고정한다.
  mkS(); A.applyCarryMode('next');
  eq('7A-3 자동+다음날 = 오늘의 자연값(기본+이월)', A.naturalFor('2026-08-08'), 70);
  eq('7A-3 자동+다음날 = 보낼 것 없음', A.payload().set.length, 0);
  mkS(); A.applyCarryMode('extend');
  {
    const pl = A.payload();
    ok('7A-3 자동+연장 = 오늘을 기본값으로 고정(자동 이월 억제)',
      pl.set.some((x) => x.date === '2026-08-08' && x.count === 40), pl.set);
    // ★★ 2026-08-07 사용자 신고("종료일 뒤에 붙이기 선택하였는데 저장이안됨")로 규칙 보강:
    //   오늘만 고정하면 **내일 자동 이월(066)이 다시 얹혀** 고른 방식이 하루 만에 무너진다
    //   (naturalFor 는 오늘만 서버 판정을 알고 앞날은 기본 일건수로 본다). 이월을 얹지 않는
    //   방식은 구간을 명시 고정해야 성립한다 — 095 규율(명시 조절일 = 그 값이 그날의 전부).
    // ★ 마지막 부분일(총량에 맞춰 남은 만큼만 연 날)만 예외 — 서버도 같은 총량 clamp 를 걸고,
    //   고정하지 않아야 앞 날이 미달했을 때 그날이 온전히 열린다(종전 규칙 유지).
    ok('★ 자동+연장 = 구간을 고정한다(내일 자동 이월이 다시 얹히는 것을 막는다)',
      pl.set.length >= sandbox.S.horiz.length - 1 && pl.set.length > 2, [pl.set.length, sandbox.S.horiz.length]);
    ok('★ 고정값은 그 방식이 깐 값 그대로', pl.set.every((x) => x.count === sandbox.S.plan[x.date]));
    ok('★ 해제(remove)로 나가지 않는다 — 해제 = 자동 이월 복귀 = 고른 방식 무효', pl.remove.length === 0, pl.remove);
  }
  // ★ 이월이 없으면 고정할 이유도 없다(불필요한 굳힘 금지)
  mkS({ data: { carryPending: 0, todayNaturalQuota: 40 } }); A.applyCarryMode('extend');
  eq('★ 이월 0 + 연장 = 보낼 것 없음', A.payload().set.length, 0);
  // ★★ 고정 중에 저장된 조절이 기본값과 같아도 **해제(remove)로 내보내지 않는다** —
  //   해제하면 그 날은 다시 자동 이월 대상이 되어 고른 방식이 무효가 된다.
  mkS({ base: { '2026-08-12': 40 }, data: { todayNaturalQuota: 70 } });
  A.applyCarryMode('extend');
  {
    const pl = A.payload();
    eq('★ 기본값과 같은 저장분도 해제하지 않는다', pl.remove.length, 0);
    // ★ 이미 같은 값으로 고정돼 있으면 다시 보내지도 않는다 — 안 걸러내면 저장 직후에도
    //   [확정 저장]이 계속 열려 있어 "저장이 안 됐나?"로 오독된다.
    ok('★ 이미 같은 값으로 저장된 날은 다시 보내지 않는다',
      !pl.set.some((x) => x.date === '2026-08-12'), pl.set);
    ok('★ 아직 고정 안 된 날은 보낸다', pl.set.some((x) => x.date === '2026-08-13'), pl.set);
  }
  // 보류 공고는 서버가 얹지 않으므로 얹으려면 명시 계획이 필요하다(그리고 연장은 보낼 것이 없다)
  mkS({ data: { carryMode: 'hold', todayNaturalQuota: 40 } }); A.applyCarryMode('next');
  eq('7A-3 보류+다음날 = 오늘 한 줄', A.payload().set.length, 1);
  eq('7A-3 보류+다음날 = 기본 40 + 이월 30', A.payload().set[0].count, 70);
  mkS({ data: { carryMode: 'hold', todayNaturalQuota: 40 } }); A.applyCarryMode('extend');
  eq('7A-3 보류+연장 = 보낼 것 없음', A.payload().set.length, 0);

  // 7A-4 ★★ 오늘의 "손 안 댄 값"은 **서버가 준 판정값**을 그대로 쓴다 — 프론트가 `기본 + 이월`로
  //   다시 계산하면 066 이월 상한(2배)·킬스위치·총량 clamp 를 몰라 서버와 갈린다(코드리뷰).
  mkS({ data: { defaultDaily: 40, carryPending: 200, todayNaturalQuota: 80 } });   // 서버가 2배로 자른 값
  eq('7A-4 오늘 자연값 = 서버 판정(240 이 아니라 80)', A.naturalFor('2026-08-08'), 80);
  ok('7A-4 프론트가 기본+이월로 되계산하지 않는다',
    !/todayNaturalQuota/.test('') && A.naturalFor('2026-08-08') !== 240);
  mkS({ data: { todayNaturalQuota: null } });
  ok('7A-4 기준값을 못 받으면 균형 모드를 켜지 않는다(잘못된 기준 저장 판정 금지)',
    A.applyCarryMode('next') === false);
  // ★★ 서버는 런타임(목록·apply)과 **같은 재료**로 계산해야 한다 — counts 를 그대로 넘긴다.
  //   plans 를 따로 만들어 덮으면 화면과 실제 정원이 갈리는 사고를 새로 만든다.
  {
    const cp = readS('services/campaignPlan.service.js');
    ok('7A-4 서버는 computeCampaignState 에 counts 를 그대로 넘긴다(재료 사본 금지)',
      /computeCampaignState\(camp, counts, new Date\(\), sch\)/.test(cp)
      && !/computeCampaignState\(camp, Object\.assign/.test(cp));
    ok('7A-4 오늘 기준값은 그 판정의 dailyQuota 를 그대로 쓴다(사본 공식 금지)',
      /todayNaturalQuota = Number\(stNow\.dailyQuota\) \|\| 0;/.test(cp));
    ok('7A-4 계산 실패는 null(0 으로 꾸미지 않는다)',
      /carryHeld = null; carryPending = null; todayNaturalQuota = null;/.test(cp));
  }

  // 7A-4b ★ 무관한 상향 조절이 실제로 남아 있는 이월을 0으로 숨기지 않는다
  mkS({ base: { '2026-08-20': 70 } });                 // 이월과 무관한 +30 저장분
  eq('7A-4b 이월은 서버값 그대로', A.carryAmt(), 30);

  // 7A-5 ★ 서버 MAX_DAY_COUNT(9999) 를 넘기지 않는다(넘기면 savePlans 가 저장 전체를 거부)
  mkS({ data: { recruitTotal: 500000, defaultDaily: 9000, carryPending: 0, submittedAll: 0, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0, todayNaturalQuota: 9000 } });
  ok('7A-5 큰 총량 공고도 균형 모드로 열린다', A.applyCarryMode('next') === true);
  ok('7A-5 배분 목표는 9999 보다 크다(상한이 실제로 물리는 조건)', A.targetTotal() > 9999, A.targetTotal());
  eq('7A-5 한 날 상한은 9999 를 넘지 않는다', A.dayCeil(), 9999);
  ok('7A-5 사람 조절 상한도 9999 를 넘지 않는다',
    sandbox.S.horiz.every((x) => A.maxFor(x) <= 9999));
  mkS({ data: { defaultDaily: 9000, carryPending: 5000, recruitTotal: 100000, submittedAll: 0, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0, todayNaturalQuota: 9999 } });
  A.applyCarryMode('next');
  ok('7A-5 이월 전액을 얹어도 9999 를 넘지 않는다',
    sandbox.S.horiz.every((x) => A.planFor(x) <= 9999), sandbox.S.horiz.map(A.planFor).slice(0, 3));

  /* 7A-12 ★★ 부족(shortBy)일 때 "방식별 종료일"에 날짜를 단정하지 않는다 (위프 800건 실측).
     `walkDays` 는 목표를 못 채워도 모아 둔 날을 돌려주고 탐색은 finitePlanLimit(마지막 날+13)에서
     끊긴다 — 그 컷오프를 종료일로 찍으면 헤더의 '계산 불가' 와 정면으로 어긋나고, 세 방식이
     전부 같은 날로 보여 "뒤에 붙여도 종료일이 안 밀린다" 는 잘못된 판단 근거가 된다. */
  {
    mkS({ data: {
      recruitTotal: 800, submittedAll: 50, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0,
      carryPending: 0, todayNaturalQuota: 40,
      worktableDates: [{ date: '2026-08-08', slots: 40 }, { date: '2026-08-09', slots: 40 }],
    } });
    const h = A.buildHorizon('next');
    ok('7A-12 작업표 자리가 목표보다 적으면 shortBy 로 모자란 인원을 보고한다', !!h && h.shortBy > 0,
      h && JSON.stringify({ shortBy: h.shortBy, n: h.dates.length }));
    const src = readF('js/campaign-daily-plan.js');
    ok('7A-12 ★★ 부족이면 방식별 종료일을 날짜로 단정하지 않는다',
      /if \(h\.shortBy > 0\) return '계산 불가';/.test(src));
    ok('7A-12 옛 배선(마지막 날을 무조건 종료일로)이 남아 있지 않다',
      !/var em = function \(m\) \{ var h = buildHorizon\(m\); return h && h\.dates\.length \?/.test(src));
  }

  /* 7A-13 ★★ 기본 이월 방식 = '종료일 뒤에 붙이기'(사용자 확정 2026-08-19 2차 — 종전 spread 에서
     뒤집혔다). next 가 기본이면 이월이 크게 쌓인 공고(위프 625명)에서 **다음 진행일 하루에 625명**이
     열리고, spread 는 각 날 인원을 말없이 늘린다. extend 는 각 날 인원을 건드리지 않고 종료일만 민다. */
  {
    eq('7A-13 ★★ 기본 이월 방식 = 종료일 뒤에 붙이기', A.DEFAULT_CARRY_MODE, 'extend');
    ok('7A-13 기본값은 실제 선택지 안에 있다', A.CARRY_MODES.indexOf(A.DEFAULT_CARRY_MODE) >= 0);
    const src = readF('js/campaign-daily-plan.js');
    ok("7A-13 ★ 기본값 하드코딩('next') 부활 차단 — 폴백이 단일 출처를 본다",
      /_loadMode\(\) \|\| DEFAULT_CARRY_MODE/.test(src)
      && !/S\.carryMode \|\| _loadMode\(\) \|\| 'next'/.test(src));
    ok("7A-13 ★ '기본' 배지는 DEFAULT_CARRY_MODE 에서 파생한다(손으로 단 배지 부활 차단)",
      /m === DEFAULT_CARRY_MODE \? '<span class="df">기본<\/span>' : ''/.test(src)
      && !/(다음날에 더하기|남은 날에 나눠 담기|종료일 뒤에 붙이기)<span class="df">기본<\/span>/.test(src));
  }

  // 7A-6 ★ 시작일이 미래여도 오늘 이후의 저장된 계획은 삭제되지 않는다
  mkS({ data: { startDate: '2026-08-20', submittedAll: 0, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0 },
        base: { '2026-08-10': 7 } });
  A.applyCarryMode('next');
  eq('7A-6 시작일 이전에 저장된 계획이 살아 있다', A.planFor('2026-08-10'), 7);
  eq('7A-6 그 계획이 remove 로 나가지 않는다', A.payload().remove.length, 0);

  // 7A-9 ★★ 사람이 줄인 마지막 날은 "총량 맞추기 절단"으로 오인해 버리지 않는다
  //   (균형이 맞은 상태의 마지막 날은 항상 residual 이라 v===residual 만 보면 조용히 누락된다)
  mkS(); A.applyCarryMode('extend');
  {
    const last = sandbox.S.horiz[sandbox.S.horiz.length - 1];
    const cut = 10;
    sandbox.S.plan[last] = A.planFor(last) - cut;       // 마지막 날을 사람이 줄이고
    sandbox.S.plan['2026-08-09'] = A.planFor('2026-08-09') + cut;   // 다른 날로 옮긴다(균형 유지)
    eq('7A-9 균형은 맞다', A.diffPlan(), 0);
    const pl = A.payload();
    ok('7A-9 올린 날이 저장된다', pl.set.some((x) => x.date === '2026-08-09'), pl.set);
    ok('7A-9 ★ 줄인 마지막 날도 저장된다(조용한 누락 금지)',
      pl.set.some((x) => x.date === last), { last: last, set: pl.set });
  }

  // 7A-8 ★★ 구간 밖(종료일 이후·시작일 이전)에 저장된 계획은 합계에 넣지도, 지우지도 않는다
  //   — 넣으면 모달을 열자마자 사람이 만들지 않은 "초과"가 뜨고 [자동 맞춤]이 그 계획을 0으로 깎는다
  mkS({ base: { '2026-09-30': 50 } });
  A.applyCarryMode('next');
  eq('7A-8 구간 밖 계획은 표에 넣지 않는다', sandbox.S.horiz.indexOf('2026-09-30'), -1);
  eq('7A-8 열자마자 초과가 뜨지 않는다', A.diffPlan(), 0);
  eq('7A-8 값은 그대로 살아 있다', A.planFor('2026-09-30'), 50);
  {
    const pl = A.payload();
    ok('7A-8 지우지 않는다(remove 없음)', pl.remove.indexOf('2026-09-30') < 0, pl.remove);
    ok('7A-8 다시 저장하지도 않는다(set 없음)', !pl.set.some((x) => x.date === '2026-09-30'), pl.set);
  }
  ok('7A-8 존재 사실을 화면이 말한다(조용히 숨기지 않는다)',
    /이 구간 밖\(시작일 이전·예상 종료일 이후\)에 저장해 둔 계획이/.test(cdpSrc));

  // 7A-7 기본값으로 되돌린 저장분은 "고정"이 아니라 **해제**로 보낸다(우선권 복귀)
  mkS({ base: { '2026-08-12': 5 } });
  A.applyCarryMode('next');
  sandbox.S.plan['2026-08-12'] = 40;                 // 기본값으로 되돌림
  {
    const pl = A.payload();
    ok('7A-7 기본값 복귀 = remove', pl.remove.indexOf('2026-08-12') >= 0, pl);
    ok('7A-7 set 에는 넣지 않는다', !pl.set.some((x) => x.date === '2026-08-12'), pl.set);
  }

  // 7A-10 ★★ 균형 모드가 꺼지면 **왜인지**를 기록한다(조용한 기능 소실 금지 — 코드리뷰 🟡2)
  mkS({ data: { recruitTotal: 0 } });          A.applyCarryMode('next'); eq('7A-10 무제한', sandbox.S.balanceOff, 'unlimited');
  mkS({ data: { submittedAll: 800, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0 } });
  A.applyCarryMode('next'); eq('7A-10 총량 충족', sandbox.S.balanceOff, 'full');
  mkS({ data: { submittedAll: 800, todaySubmitted: 2, byDateSubmitted: { '2026-08-08': 2 }, todayUsed: 40 } });
  A.applyCarryMode('next'); eq('7A-10 오늘 확정이 남은 배분수 초과', sandbox.S.balanceOff, 'today_over');
  mkS({ data: { todayNaturalQuota: null } });   A.applyCarryMode('next'); eq('7A-10 기준값 없음', sandbox.S.balanceOff, 'no_baseline');
  {
    // ★ 시트 일정 공고 + 과거 미달 = 앞으로의 시트 자리가 배분해야 할 인원보다 적다
    //   (코드리뷰가 표로 보여준 케이스 — 이월 조절이 가장 필요한 상태인데 조용히 꺼졌다)
    const dates = [];
    for (let i = 0; i < 5; i++) dates.push({ date: new Date(Date.UTC(2026, 7, 8 + i)).toISOString().slice(0, 10), slots: 20 });
    mkS({ data: {
      scheduleDriven: true, scheduleDates: dates, scheduleTotal: 300, recruitTotal: 300, defaultDaily: 20,
      submittedAll: 5, todaySubmitted: 5, byDateSubmitted: { '2026-08-08': 5 }, todayUsed: 5,
      carryPending: null, todayNaturalQuota: 20,
    } });
    // ★★ 2026-08-07 사용자 신고로 규칙 변경: 시트 계획이 목표보다 적은 것은 **기능 불가가 아니라
    //   "부족(파랑) — 저장불가"** 그 자체다(요구 ⑥). 종전엔 균형 모드를 통째로 끄고 안내문만
    //   "어느 날의 인원을 늘려주세요"라고 말해, 시키는 대로 늘려도 아무 변화가 없는 막다른 길이었다.
    ok('★ 시트 자리 부족이어도 균형 모드는 켜진다(늘리면 초록이 되는 창구)', A.applyCarryMode('next') === true);
    eq('★ 꺼진 사유는 없다', sandbox.S.balanceOff, null);
    eq('★ 부족분을 기록한다(안내 문구 재료)', sandbox.S.shortBy, 200);
    eq('구간 = 실제 진행일 + 0명 조절 창', sandbox.S.horiz.length, 18);
    ok('균형 바는 "부족"으로 뜬다(합계 < 배분해야 할 인원)', A.sumPlan() < A.targetTotal(), [A.sumPlan(), A.targetTotal()]);
    // 사람이 인원을 올리면 그대로 일치(저장가능)가 된다 — 안내문이 시키는 조치가 실제로 통해야 한다
    sandbox.S.plan[sandbox.S.horiz[0]] += 200;
    eq('★ 늘리면 합계가 맞는다(막다른 길 아님)', A.diffPlan(), 0);
  }
  {
    // 진행일이 **아예 없을 때만** 균형 모드를 끈다
    mkS({ data: {
      scheduleDriven: true, scheduleDates: [], scheduleTotal: 300, recruitTotal: 300, defaultDaily: 0,
      submittedAll: 0, todaySubmitted: 0, byDateSubmitted: {}, todayUsed: 0, carryPending: null, todayNaturalQuota: 0,
    } });
    ok('7A-10 진행일 0개 = 균형 모드 꺼짐', A.applyCarryMode('next') === false);
    eq('7A-10 사유는 "자리 부족"', sandbox.S.balanceOff, 'no_room');
  }
  // ⚠ 실브라우저가 잡은 것: 안내 문구가 render() 아래에서 var 선언되는 `target` 을 참조해
  //   **undefined명**으로 렌더됐다(호이스팅). 정적 검사로는 못 잡는다 → 함수 호출을 고정한다.
  ok('7A-10 ★ 안내 문구는 아래에서 선언되는 var 를 참조하지 않는다(undefined 렌더 방지)', (() => {
    // 안내 문구 블록은 `var target = targetTotal()` **위**에 있다 → 그 안에서 bare `target` 을
    //   쓰면 호이스팅으로 undefined 가 렌더된다(실브라우저가 잡은 것, 정적으로만 고정 가능).
    const a = cdpSrc.indexOf("var offNote = ''");
    const b = cdpSrc.indexOf('var balBlk', a);
    // ⚠ 주석은 지우고 본다(경고 주석에 `target` 이라고 적혀 있다) — 블록 주석 정규식은 이 레포의
    //   정규식 리터럴을 물어 코드를 통째로 삼키므로 **줄 주석만** 지운다.
    const code = cdpSrc.slice(a, b).replace(/^\s*\/\/.*$/gm, '');
    return a > 0 && b > a && !/\btarget\b(?!Total)/.test(code);
  })());
  ok('7A-10 ★ 사유별 안내 문구가 다음 행동까지 말한다(시트 공고는 시트에 날짜 추가)',
    /앞으로 진행할 날이 없어/.test(cdpSrc) && /시트에 진행 날짜를 더 넣어주세요/.test(cdpSrc)
    && /오늘 이미 확정·진행 중인 인원이 남은 배분수보다 많아/.test(cdpSrc));
  ok('★ 부족 상태는 균형 모드 안에서 사유·다음 행동을 말한다(조용한 파랑 금지)',
    /bal && S\.shortBy > 0 && diffPlan\(\) < 0/.test(cdpSrc) && /명<\/b>이 모자랍니다/.test(cdpSrc));
  ok('★ 부족은 저장 가능 — 남은건수보다 적게 모집한다고 말한다(2026-08-19 확정)',
    /건 적게 모집합니다\. — <b>저장가능<\/b>/.test(cdpSrc)
    && /총량보다 ' \+ \(-diff\) \+ '명 적게 모집합니다 — 저장하면 작업표도 그 수로 줄어듭니다/.test(cdpSrc));

  // 7A-11 ★★ 한 날에 평소 상한을 넘겨 여는 배치는 **경고한다**(막지는 않는다 — 사용자가 고른 방식)
  ok('7A-11 066 하루 상한 초과 경고 + 대안 제시',
    /자동 이월이었다면 오늘은 <b>' \+ Number\(j\.todayNaturalQuota \|\| 0\) \+ '명<\/b>까지만 열립니다/.test(cdpSrc)
    && /\[남은 날에 나눠 담기\]<\/b>를 고르세요/.test(cdpSrc));
  /* ★ 2026-08-19 사용자 확정: **초과만 막고 부족은 저장한다**(부족하게 저장하면 그만큼만 모집하고
     작업표의 줄도 그 수로 줄어든다). 하드블록 금지 규율 자체는 그대로. */
  ok('7A-11 경고일 뿐 저장을 막지 않는다(초과만 잠그고 부족은 저장 가능)',
    /save\.disabled = killOff \|\| S\.saving \|\| diff > 0 \|\| !dirty \|\| over;/.test(cdpSrc)
    && !/todayNaturalQuota[^\n]*save\.disabled/.test(cdpSrc));

  /* ── 배선(정적) — 사용자 확정 문구·규율이 코드에 그대로 있는가 ── */
  const CDP = cdpSrc;
  /* ★ 2026-08-19 확정으로 문구가 3갈래가 됐다 — 일치(저장가능) / 초과(저장불가) /
     부족(저장가능 · 그만큼만 모집). 부족을 "저장불가"로 되돌리면 그 확정이 깨진다. */
  /* ★★ 2026-08-19 사용자 신고로 문구가 바뀌었다 — "총량 410명"은 거짓(총원은 500명이고 410 은
     남은 건수). 진행 현황(확정/총원)과 남은건수를 함께 말한다. 되돌리면 그 오해가 재현된다. */
  ok('7n 요구 ⑥ 문구(초과/부족/일치) — 진행 현황 + 남은건수 기준',
    /'<span class="num">' \+ done \+ '<\/span> \/ ' \+ tot \+ '건 진행중 · 남은건수 <span class="num">' \+ target \+ '<\/span>건'/.test(CDP)
    && /pre \+ ' 일치합니다\. — <b>저장가능<\/b>'/.test(CDP)
    && /'<\/span>건 초과입니다\. — <b>저장불가<\/b>'/.test(CDP)
    && /'<\/span>건 적게 모집합니다\. — <b>저장가능<\/b>'/.test(CDP));
  /* ★★ 입력 3창구(게이지 드래그 · ±/기본으로 · 숫자 직접 입력)가 **같은 상한 함수**를 쓴다 —
     한 곳이라도 빠지면 그 창구로만 총량을 넘길 수 있다(사용자 확정 2026-08-19). */
  ok('7n-2 ★ 드래그·커밋이 날짜별 상한 maxFor(d) 를 쓴다',
    /v = Math\.max\(minFor\(drag\.d\), Math\.min\(maxFor\(drag\.d\), v\)\);/.test(CDP)
    && /var cur = planFor\(d\), want = Math\.round\(next\), cap = maxFor\(d\);/.test(CDP)
    && /next = Math\.max\(minFor\(d\), Math\.min\(cap, want\)\);/.test(CDP));
  ok('7n-3 ★ 막고 끝내지 않는다 — 총건수·남은건수를 문장으로 말한다',
    /want > cap && balanceOn\(\)/.test(CDP)
    && /총 ' \+ totalFor\(\) \+ '건을 넘길 수 없습니다 — 남은건수 /.test(CDP)
    && /\[차수 추가\]로 총량을 늘려주세요/.test(CDP));
  ok('7o ★ 알림창 높이는 "일치" 기준 41px 고정(상태마다 표가 흔들리면 조절하던 줄을 놓친다)',
    /\.cdp-bal\{box-sizing:border-box;position:sticky;top:0;z-index:5;border-radius:11px;height:41px/.test(CDP));
  ok('7p ★ 종료일 연장 문구 — 사용자 확정 문장(숫자는 실제 마지막 진행일에서 읽는다)',
    /이월 <b>' \+ carry \+ '명<\/b>을 <b>종료일 연장<\/b>으로 넘겼습니다 — 추가된 종료일 <b>/.test(CDP)
    && /'<\/b>에 <b>' \+ \(lastD \? planFor\(lastD\) : 0\) \+ '명<\/b> 늘어납니다\./.test(CDP));
  /* ⚠ 2026-08-19 사용자 확정으로 **기본값이 뒤집혔다** — "다음날로 이월하는 것이 기본값이
     되어선 안 된다"(위프 800건 이월 625명이 다음 진행일 하루에 몰리는 것을 실측하고 결정).
     되돌리면 그 사고가 재현된다. 상세는 7A-13. */
  ok('7q ★ 기본 보충 방식 = 종료일 뒤에 붙이기(사용자 확정 2026-08-19 2차) — 여는 순간 적용',
    /applyCarryMode\(DEFAULT_CARRY_MODE\);/.test(CDP)
    && /segBtn\('extend', '종료일 뒤에 붙이기'/.test(CDP));
  ok('7r ★ 저장 게이트 = 초과 아님 AND 저장할 것 있음 AND 상한 이내(버튼·본문 이중)',
    /save\.disabled = killOff \|\| S\.saving \|\| diff > 0 \|\| !dirty \|\| over;/.test(CDP)
    && /if \(balanceOn\(\) && \(diffPlan\(\) > 0 \|\| set\.length \+ remove\.length > MAX_ROWS\)\) return;/.test(CDP));
  ok('7s ★ 저장 상한은 서버 MAX_PLAN_ENTRIES 와 같은 값(넘으면 사유를 말하고 잠근다)',
    A.MAX_ROWS === 120
    && /const MAX_PLAN_ENTRIES = 120;/.test(readS('services/campaignPlan.service.js'))
    && /한 번에 저장 가능한 ' \+ MAX_ROWS \+ '일을 넘었습니다/.test(CDP));
  /* ★ 세그먼트 버튼이 segBtn 한 벌로 모이면서 mode 는 인자가 됐다 — 대신 **CARRY_MODES
     화이트리스트**로 잠그고, 호출부는 고정 문자열만 넘긴다(보간 사고 차단). */
  ok('7t ★ 방식 전환 onclick 은 화이트리스트 통과 값만(외부 값 보간 금지 — XSS 규율)',
    /if \(CARRY_MODES\.indexOf\(m\) < 0\) return '';/.test(CDP)
    && /segBtn\('next', /.test(CDP) && /segBtn\('spread', /.test(CDP) && /segBtn\('extend', /.test(CDP)
    && !/\+ segBtn\((?!'(next|spread|extend)')/.test(CDP));
  ok('7u ★ 균형 모드에서는 보류 블록을 그리지 않는다(반영 창구가 둘이면 이중 반영)',
    /if \(bal\) \{\n\s*\/\/ 균형 모드에서는 위 "이월 보충 투입 방식"이 반영 창구다/.test(CDP));
  ok('7v ★ 균형 모드에서는 「빠진 인원 처리」 팝업을 띄우지 않는다(판정 단일 출처 = 균형 바)',
    /if \(balanceOn\(\)\) \{ S\.notes\.push\(fmtMD\(d\) \+ ' ' \+ start \+ '→' \+ fin\); render\(\); return; \}/.test(CDP));
  ok('7w ★ 숫자 직접 입력은 change 에서만 반영(입력 중 재렌더 = 한글 IME 파괴)',
    /wrap\.addEventListener\('change', function/.test(CDP) && !/addEventListener\('input'/.test(CDP));
  ok('7x ★ 확정 저장은 확인창 없이 즉시 저장하고 결과는 토스트로 알린다',
    /브라우저 확인창을 한 번 더 띄우지 않고/.test(CDP)
    && /toast\('저장했습니다/.test(CDP));
  ok('7x-2 ★ 자동+다음날의 "저장할 것 없음"은 "이미 반영 중"이라고 말한다(미반영 오독 금지)',
    /이월 ' \+ carry \+ '명은 이미 오늘 정원에 반영되어 있습니다/.test(CDP)
    && /carry > 0 && S\.carryMode === 'next' && j\.carryMode !== 'hold'/.test(CDP));
  ok('7y ★ 이월 계산 불가는 "?" 로 말한다(0 으로 꾸미지 않는다)',
    /↩ 이월 \?/.test(CDP) && /carry === null/.test(CDP));
  ok('7z ★ 요구 ②③ — 현재 모집인원/총건수·예상 종료일이 조절 화면 위에 있다',
    /모집 현황 <em>' \+ done \+ '<\/em> \/ '/.test(CDP) && /예상 종료일 <b class="end">/.test(CDP));

  /* ══ §8 표 머리 고정 + 목록만 스크롤 + 요일·공휴일 색 (사용자 확정 2026-08-07) ══ */
  console.log('\n[8] 고정 헤더 · 목록 스크롤 · 요일/공휴일 색');
  // ★ 위(안내·현황·이월 방식·균형 바·표 머리)는 고정, 스크롤은 날짜 목록부터
  ok('8-1 본문은 스크롤하지 않고 내부에 고정/스크롤 두 영역을 둔다',
    /\.cdp-bd\{[^}]*overflow:hidden[^}]*display:flex[^}]*flex-direction:column/.test(CDP)
    && /\.cdp-fix\{/.test(CDP) && /\.cdp-sc\{[^}]*overflow-y:auto/.test(CDP));
  ok('8-1 ★ flex 자식에 min-height:0 (없으면 스크롤이 안 생기고 내용만큼 늘어난다)',
    /\.cdp-bd\{[^}]*min-height:0/.test(CDP) && /\.cdp-sc\{[^}]*min-height:0/.test(CDP));
  ok('8-2 렌더가 공용 좌측 요약과 우측 고정/스크롤 계획 영역을 만든다', (() => {
    const layout = CDP.indexOf("'<div class=\"cdp-layout\"><aside class=\"cdp-side\">'");
    const a = CDP.indexOf('class="cdp-fix"', layout);
    const b = CDP.indexOf('class="cdp-sc"', a);
    const sub = CDP.indexOf('날짜별 모집 계획 — 게이지 드래그');
    const rows = CDP.indexOf("'<div id=\"cdpRows\">'");
    return layout > 0 && a > layout && b > a && sub > a && sub < b && rows > b;
  })());
  ok('8-2a 날짜별 계획표는 날짜·상태·일 건수·조절 4열을 렌더한다',
    /cdp-colhead[^]*날짜[^]*상태[^]*일 건수[^]*조절/.test(CDP)
    && /grid-template-columns:148px 72px 66px minmax\(190px,1fr\)/.test(CDP)
    && /cdp-state/.test(CDP));
  ok('8-3 ★ 조절해도 보던 자리를 지킨다(render 가 스크롤 컨테이너를 새로 만든다)',
    /S\._scrollTop/.test(CDP) && /sc\.scrollTop = S\._scrollTop/.test(CDP)
    && /sc\.addEventListener\('scroll'/.test(CDP));

  // 요일·공휴일 — 순수함수 실행
  eq('8-4 토요일 = 파랑', A.dayKind('2026-08-08'), 'sat');
  eq('8-4 일요일 = 빨강', A.dayKind('2026-08-09'), 'hol');
  eq('8-4 평일 = 색 없음', A.dayKind('2026-08-10'), '');
  eq('8-4 ★ 공휴일(광복절)은 토요일이어도 빨강', A.dayKind('2026-08-15'), 'hol');
  eq('8-4 공휴일 이름', A.holidayName('2026-08-15'), '광복절');
  eq('8-4 ★ 음력 공휴일(추석)도 잡는다', A.holidayName('2026-09-25'), '추석');
  eq('8-4 ★ 대체공휴일도 잡는다', A.holidayName('2026-03-02'), '삼일절 대체');
  eq('8-4 잘못된 값은 조용히 빈 값', A.dayKind('not-a-date'), '');
  // ★★ 표에 없는 연도는 **고정일만** — 음력 공휴일을 추측으로 칠하지 않는다(틀린 값 > 빈 값)
  eq('8-5 ★ 표 밖 연도도 고정일은 잡는다', A.holidayName('2031-01-01'), '신정');
  eq('8-5 ★★ 표 밖 연도의 음력 공휴일은 추측하지 않는다', A.holidayName('2031-02-11'), '');
  ok('8-5 음력·대체는 연도별 확정값 표로만 둔다(계산식 금지)',
    Object.keys(A.LUNAR_HOLIDAYS).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    && Object.keys(A.FIXED_HOLIDAYS).every((k) => /^\d{2}-\d{2}$/.test(k)));
  ok('8-6 행 렌더가 날짜 칸에 색 클래스와 공휴일 이름을 붙인다',
    /var dk = dayKind\(d\), hol = holidayName\(d\);/.test(CDP)
    && /class="cdp-d' \+ \(dk \? ' ' \+ dk : ''\)/.test(CDP)
    && /cdp-tag hol/.test(CDP));
  ok('8-6 색은 리터럴(테마 없는 호스트에도 얹힌다)',
    /\.cdp-d\.hol\{color:#dc2626/.test(CDP) && /\.cdp-d\.sat\{color:#2563eb/.test(CDP));

  /* ══ §9 고른 이월 방식은 저장·재조회·재오픈에도 유지된다 (사용자 신고 2026-08-07) ══ */
  console.log('\n[9] 이월 방식 유지 — 저장 후 게이지가 조절 전으로 되돌아가지 않는다');
  // ★ applyOverview 는 저장 직후에도 다시 도는데 무조건 'next' 로 깔면 이월이 오늘에 다시 얹혀
  //   **저장이 되돌아간 것처럼 보인다**(실제 저장값은 그대로 — 화면만 다른 방식으로 재제안).
  ok('9-1 ★ 재조회 시 고른 방식을 그대로 쓴다(무조건 기본값 금지)',
    /var want = S\.carryMode \|\| j\.carryStrategy \|\| _loadMode\(\) \|\| DEFAULT_CARRY_MODE;/.test(CDP)
    && /if \(!applyCarryMode\(want\) && want !== DEFAULT_CARRY_MODE\) applyCarryMode\(DEFAULT_CARRY_MODE\);/.test(CDP));
  ok('9-1 옛 배선(무조건 next)이 남아 있지 않다', !/^\s*applyCarryMode\('next'\);$/m.test(CDP));
  ok('9-2 방식을 고르면 기억한다(재오픈에도 유지)',
    /_saveMode\(m\);/.test(CDP) && /MODE_KEY = 'cdp_carry_mode_'/.test(CDP));
  ok('9-2 ★ 기억은 화면 상태일 뿐 — 실패해도 무시(사생활 보호 모드)',
    /catch \(_\) \{ return null; \}/.test(CDP) && /catch \(_\) \{\}/.test(CDP));
  ok('9-2 모르는 값은 쓰지 않는다(저장된 쓰레기 값 방어)',
    /CARRY_MODES\.indexOf\(v\) >= 0 \? v : null/.test(CDP));

  console.log(`\n✅ campaignDailyPlan: ${n}개 통과`);
  process.exit(0);   // trackB.routes require 가 풀 핸들을 열어 프로세스가 안 끝난다(레포 관용구)
})().catch((e) => { console.error('❌ 실패:', e.message); console.error(e.stack); process.exit(1); });
