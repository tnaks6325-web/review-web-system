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
 *   ⑤ 시트 일정 캠페인은 저장 거부(시트가 진실원본 — 확정 ③).
 *
 * 실행: node tests/campaignDailyPlan.test.js
 *   (PGTEST_URL=postgres://… 지정 시 진짜 PG로 마이그레이션·유니크·CASCADE까지 검증)
 */
process.env.PGTEST_SKIP_BOOT = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readM = (p) => fs.readFileSync(path.join(__dirname, '..', 'migrations', p), 'utf8');

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
    ok(`라우트 ${m.toUpperCase()} ${p} 등록 + 미들웨어 체인(auth→adminOrMaster→핸들러)`, l && l.count >= 3);
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
    /const chips = `\$\{holdTip\}\$\{planTip\}\$\{carryTip\}`;/.test(cards)
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
  ok('저장은 confirm 경유([확정 저장])', /window\.confirm\('아래 조절을 저장할까요/.test(modal));
  ok('마운트 body 직속', /document\.body\.appendChild/.test(modal));
  ok('★ onclick 에 서버 문자열 보간 없음(XSS 규율)', !/onclick="[^"]*\$\{/.test(modal));
  // ★★ 시트 일정 공고도 조절 가능 — 읽기 전용 잠금이 되살아나면 실패한다(사용자 확정 2026-08-07)
  ok('★ 시트 일정 공고 읽기 전용 잠금 부재(조절 허용)',
    !/여기서는 조절할 수 없습니다/.test(modal) && !/시트 일정 캠페인 — 읽기 전용/.test(modal));
  ok('★ 시트 계획을 기준선으로 표시(baseFor/sheetFor 단일 출처) + 규칙 안내',
    /function sheetFor\(d\)/.test(modal) && /function baseFor\(d\)/.test(modal)
    && /S\.data\.scheduleDriven === true \? sheetFor\(d\) :/.test(modal)
    && /여기서 조절한 날짜만 시스템 값이 우선/.test(modal));
  ok('★ 시트 일정 공고는 보류 미적용을 사유로 말한다(조회 실패로 뭉뚱그리지 않는다)',
    /이월 보류 설정이 적용되지 않습니다/.test(modal)
    && /시트 일정 공고에는 이월 보류가 적용되지 않습니다/.test(modal));
  // ★★ 코드리뷰 #3 — "기본" 판정이 baseFor 단일 출처를 지켜야 한다. defaultDaily 로 비교하면
  //   ① 시트 15인 날을 20(=daily_limit)으로 올릴 때 조절이 조용히 삭제되고(setPlan)
  //   ② 시트 30인 날을 22로 줄여도 축소 질문이 안 뜬다(settle).
  ok('★ setPlan/settle/기본으로/저장확인/눈금선이 baseFor 를 쓴다(defaultDaily 사본 금지)',
    /if \(v === baseFor\(d\) && S\.base\[d\] == null\) delete S\.plan\[d\];/.test(modal)
    && /var dl = baseFor\(d\);/.test(modal)
    && /commitValue\(d2, baseFor\(d2\)\)/.test(modal)
    && /x\.count === baseFor\(x\.date\)/.test(modal)
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
      ok('마이그레이션 2회 적용 무사(idempotent)', true);
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

  console.log(`\n✅ campaignDailyPlan: ${n}개 통과`);
  process.exit(0);   // trackB.routes require 가 풀 핸들을 열어 프로세스가 안 끝난다(레포 관용구)
})().catch((e) => { console.error('❌ 실패:', e.message); console.error(e.stack); process.exit(1); });
