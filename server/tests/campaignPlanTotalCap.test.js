/**
 * 모집인원 조절은 **총 모집 인원 안에서만** — 총량 게이트 회귀가드 (2026-08-19, 사용자 확정)
 *
 * 규칙: 총인원·일건수는 작업오더에서 받은 값으로 고정하고(모집공고 수정에서 잠금),
 *   날짜별 조절은 그 총량을 나눠 담는 일이다. 그래서 "이미 확정된 인원 + 앞으로의 계획"이
 *   총량을 넘으면 savePlans 가 거부한다(422 over_total).
 *
 * ★ 계획 없는 날의 자연 정원은 세지 않는다(런타임 총량 clamp 담당) — 거부는 확실한 초과에만.
 * ★ 조회 실패는 통과(fail-open) — 게이트가 죽었다고 조절 자체가 막히면 막다른 길이 된다.
 *
 * 실행: node tests/campaignPlanTotalCap.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CALLS = [];
let STUB = {};
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
const d = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const P = require('../src/services/campaignPlan.service');
const schedMod = require('../src/services/campaignSchedule.service');
schedMod.deriveSchedules = async () => new Map();
schedMod.scheduleFor = () => null;

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

const CAMP = { id: 'c1', title: 't', status: 'active', participation_mode: true,
  daily_limit: 10, recruit_total: 200, start_date: null,
  linked_sheet_id: null, linked_tab_name: null, linked_tab_gid: null };
const base = (over = {}) => ({
  'FROM recruit_campaigns WHERE id': [Object.assign({}, CAMP, over.camp || {})],
  'FROM campaign_daily_plans WHERE campaign_id = $1 AND plan_date >= $2': over.plans || [],
  'FROM campaign_daily_plans': over.plansAll || [],
  'FROM campaign_rounds': [],
  'campaign_plan_events': [],
  // 총량 게이트의 확정 집계(all_n/today_n) — 하한 검사용 today_submitted/today_holds 와 같은 스텁 행
  'FROM campaign_applications': over.apps || [{ all_n: 0, today_n: 0, today_submitted: 0, today_holds: 0, n: 0 }],
});

(async () => {
  /* 1. 총량 안이면 저장된다 */
  STUB = base();
  const okSave = await P.savePlans('c1', { set: [{ date: d(1), count: 50 }] }, 't');
  ok('총량(200) 안의 조절은 저장된다', okSave.applied === 1);

  /* 2. 총량을 넘기면 거부 + 숫자 동봉 */
  STUB = base({ apps: [{ all_n: 150, today_n: 0, today_submitted: 0, today_holds: 0, n: 150 }] });
  await assert.rejects(P.savePlans('c1', { set: [{ date: d(1), count: 60 }] }, 't'),
    (e) => e.code === 'over_total' && e.cap === 200 && e.need === 210 && /20\d?명을 줄여주세요|10명을 줄여주세요/.test(e.message));
  ok('★ 확정 150 + 계획 60 = 210 > 총 200 → over_total 거부(cap·need 동봉)', true);

  /* 3. 거부되면 쓰기 쿼리가 하나도 안 나간다(부분 저장 없음) */
  CALLS.length = 0;
  STUB = base({ apps: [{ all_n: 150, today_n: 0, today_submitted: 0, today_holds: 0, n: 150 }] });
  await assert.rejects(P.savePlans('c1', { set: [{ date: d(1), count: 60 }] }, 't'), (e) => e.code === 'over_total');
  ok('★ 거부 시 계획 업서트·이력 기록 0건',
    !CALLS.some(c => c.sql.includes('INSERT INTO campaign_daily_plans'))
    && !CALLS.some(c => c.sql.includes('INSERT INTO campaign_plan_events')));

  /* 4. 기존 계획도 함께 센다(이번 저장분만 보면 새 나간다) */
  STUB = base({ plans: [{ date: d(2), count: 150 }] });
  await assert.rejects(P.savePlans('c1', { set: [{ date: d(1), count: 60 }] }, 't'), (e) => e.code === 'over_total');
  ok('★ 이미 저장된 미래 계획(150)과 이번 조절(60)을 합쳐 판정', true);

  /* 4-1. 이미 초과된 옛 계획은 축소를 저장할 수 있어야 복구 가능하다.
     새 날짜/증원은 그대로 over_total로 막고, 같은 명시 계획을 낮추는 경우만 허용한다. */
  STUB = base({ plans: [{ date: d(1), count: 250 }] });
  const recover = await P.savePlans('c1', { set: [{ date: d(1), count: 220 }] }, 't');
  ok('★ 이미 초과된 계획도 축소(250→220)만은 저장해 복구할 수 있다', recover.applied === 1);
  STUB = base({ plans: [{ date: d(1), count: 250 }] });
  await assert.rejects(P.savePlans('c1', { set: [{ date: d(1), count: 260 }] }, 't'), (e) => e.code === 'over_total');
  ok('★ 이미 초과된 계획을 더 늘리는 저장은 계속 over_total 거부', true);

  /* 5. 같은 날짜를 덮어쓰면 옛 값이 아니라 새 값으로 센다 */
  STUB = base({ plans: [{ date: d(1), count: 190 }] });
  const over5 = await P.savePlans('c1', { set: [{ date: d(1), count: 30 }] }, 't');
  ok('★ 같은 날짜 덮어쓰기는 새 값으로 센다(190→30 이면 통과)', over5.applied === 1);

  /* 6. 오늘 확정분과 오늘 계획을 이중 계수하지 않는다 */
  STUB = base({ apps: [{ all_n: 100, today_n: 100, today_submitted: 100, today_holds: 0, n: 100 }] });
  const okToday = await P.savePlans('c1', { set: [{ date: today, count: 100 }, { date: d(1), count: 100 }] }, 't');
  ok('★ 오늘 확정 100 + 오늘 계획 100 은 겹치는 개념 — 큰 쪽 하나만 센다(100+100=200 통과)', okToday.applied === 2);

  /* 7. 총량 0(무제한)은 검사하지 않는다 */
  STUB = base({ camp: { recruit_total: 0 }, apps: [{ all_n: 5000, today_n: 0, today_submitted: 0, today_holds: 0, n: 5000 }] });
  const unlimited = await P.savePlans('c1', { set: [{ date: d(1), count: 9000 }] }, 't');
  ok('총량 0(무제한)은 게이트 대상이 아니다', unlimited.applied === 1);

  /* 8. 해제(remove)만 있는 저장은 게이트를 타지 않는다(줄이는 방향) */
  STUB = base({ plansAll: [{ date: d(1), count: 10 }], apps: [{ all_n: 999, today_n: 0, today_submitted: 0, today_holds: 0, n: 999 }] });
  const rm = await P.savePlans('c1', { remove: [d(1)] }, 't');
  ok("해제만 하는 저장은 총량 게이트 대상이 아니다", rm.applied === 1);

  /* 9. 조회 실패는 통과시킨다(fail-open) — 막다른 길 금지 */
  STUB = base();
  STUB['FROM campaign_applications'] = (sql) => {
    if (String(sql).includes('all_n')) { const e = new Error('boom'); throw e; }
    return { rows: [{ today_submitted: 0, today_holds: 0, n: 0 }] };
  };
  const failOpen = await P.savePlans('c1', { set: [{ date: d(1), count: 10 }] }, 't');
  ok('★ 총량 조회 실패는 저장을 막지 않는다(fail-open + 경고)', failOpen.applied === 1);

  /* 10. 판정 기준·배선 */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignPlan.service.js'), 'utf8');
  /* ⚠ 2026-08-24: 총량 기준에 **발주 폴백**이 합류했다(공고 총인원 0 = 미설정이면 발주서 총건수가
     실제 정원 — `displayRecruitTotal`, 상태엔진·작업 조건 카드와 같은 판정). 종전엔 `recruit_total`
     만 봐서 그런 작업의 게이트가 통째로 꺼져 있었다. **검사 의미는 같거나 더 강하다** — 여전히
     "런타임 판정과 같은 기준"이고, 사본을 만들지 않았음을 함께 고정한다. */
  ok('★ 총량 기준은 런타임 판정과 같다(시트 일정=totalSlots · 그 외=displayRecruitTotal(공고→발주))',
    /function _totalCapFor\(camp, schedule, orderTotal = 0\)[\s\S]{0,900}schedule\.totalSlots[\s\S]{0,700}displayRecruitTotal\(camp && camp\.recruit_total, orderTotal\)\.total/.test(src));
  ok('★ 정원 판정 사본을 만들지 않는다(recruit_total 직접 반환 부활 차단)',
    !/return Number\(camp && camp\.recruit_total\) \|\| 0;/.test(src));
  ok('★ 게이트는 캠페인 행 잠금 뒤·쓰기 앞에서 돈다',
    src.indexOf('FOR UPDATE') < src.indexOf('SAVEPOINT plan_total')
    && src.indexOf('SAVEPOINT plan_total') < src.indexOf('INSERT INTO campaign_daily_plans'));
  ok('★ 초과 상태 예외는 기존 명시 계획을 낮추는 경우로만 한정한다',
    /const onlyReductions = set\.length > 0\s*&&\s*set\.every\(x =>[\s\S]{0,180}beforePlans\.has\(x\.date\)[\s\S]{0,140}x\.count\) <= Number\(beforePlans\.get\(x\.date\)\)/.test(src));
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  ok('★ over_total 은 400대로 매핑된다(errorHandler 500 마스킹 방지)', /over_total: 4\d\d/.test(routes));

  console.log(`\ncampaignPlanTotalCap: ${passed} passed`);
  process.exit(0);
})();
