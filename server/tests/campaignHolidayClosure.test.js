/**
 * campaignHolidayClosure.test.js — "주말 제외" = 주말 + 법정공휴일 제외 (2026-09-23 추석 사고).
 *
 * 사고: 조절 화면은 추석을 휴무(0명)로 그렸지만 서버는 공휴일을 몰라 9/24 를 기본 30명으로 열었다.
 *   화면의 0명은 "기본값 그대로"라 저장되지 않았고, 작업보드의 추석 줄도 그대로 남았다.
 *
 * ★★ 이 가드가 고정하는 것
 *   ① 공휴일 목록 단일 출처(utils/krHolidays) — 조절 화면의 사본과 글자 그대로 일치
 *   ② 쉬는 날 판정(closedKindOn/isWeekendClosedOn)이 공휴일을 닫는다 · 1명 이상 계획은 연다 · 0명은 닫는다
 *   ③ 신청 거절·카드 재개일이 "다음 월요일" 고정이 아니라 실제 첫 진행일
 *   ④ 이월 — 계획 없는 쉬는 날 몫은 "원래 받기로 한 인원"에서 빠진다(주말 포함 공고는 불변)
 *   ⑤ 새 작업표 날짜 분배가 공휴일을 건너뛴다 · 발행 프리필이 쉬는 날에 적지 않는다
 *   ⑥ 정리 도구 — 미리보기 쓰기 0 · 시스템 작성분만 · 이력 기록
 *   ⑦ 조절 화면 — [0명 확정]이 명시 0 으로 저장되고 "해제(remove)"로 빠지지 않는다
 *   ⑧ 신청 첫 관문은 참여형 공고를 계획 없이 막지 않는다 · 관리자 목록은 계획을 넘긴다
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function ok(msg, cond) {
  if (cond) { console.log(`  ✓ ${msg}`); return; }
  failed++; console.log(`  ✗ ${msg}`);
}

const kr = require('../src/utils/krHolidays');
const wk = require('../src/services/campaignWeekend.service');
const cs = require('../src/services/campaignState.service');
const wp = require('../src/utils/worktablePlan');

const SKIP = { skip_weekends: true };
const INCL = { skip_weekends: false };

/* ── [1] 공휴일 목록 단일 출처 ─────────────────────────────── */
console.log('\n[1] 공휴일 목록');
{
  ok('추석 3일(9/24·25·26)이 공휴일', kr.isHoliday('2026-09-24') && kr.isHoliday('2026-09-25') && kr.isHoliday('2026-09-26'));
  ok('고정일(개천절)은 연도 무관', kr.holidayName('2030-10-03') === '개천절');
  ok('평일은 공휴일 아님', !kr.isHoliday('2026-09-28'));
  ok('형식 밖 값은 공휴일로 단정하지 않는다', !kr.isHoliday('9/24') && !kr.isHoliday(null));
  ok('표가 없는 해를 구분한다(경고 재료)', kr.isLunarYearKnown('2026-01-01') && !kr.isLunarYearKnown('2029-01-01'));

  const src = read('../frontend/js/campaign-daily-plan.js');
  const grab = name => {
    const m = src.match(new RegExp('var ' + name + ' = (\\{[\\s\\S]*?\\});'));
    return m ? vm.runInNewContext('(' + m[1] + ')') : null;
  };
  ok('★★ 조절 화면의 고정일 표 = 서버 표(사본 드리프트 금지)',
    JSON.stringify(grab('FIXED_HOLIDAYS')) === JSON.stringify(kr.FIXED_HOLIDAYS));
  ok('★★ 조절 화면의 음력·대체공휴일 표 = 서버 표(한쪽만 고치면 추석 사고 재현)',
    JSON.stringify(grab('LUNAR_HOLIDAYS')) === JSON.stringify(kr.LUNAR_HOLIDAYS));
}

/* ── [2] 쉬는 날 판정 ─────────────────────────────────────── */
console.log('\n[2] 쉬는 날 판정');
{
  ok('★★ 주말 제외 공고의 공휴일(목)은 닫힌다', wk.closedKindOn(SKIP, '2026-09-24') === 'holiday' && wk.isWeekendClosedOn(SKIP, '2026-09-24'));
  ok('주말은 weekend', wk.closedKindOn(SKIP, '2026-09-27') === 'weekend');
  ok('평일은 열린다', !wk.isWeekendClosedOn(SKIP, '2026-09-28'));
  ok('★ 주말 포함 공고는 공휴일도 연다(종전 동작 불변)', !wk.isWeekendClosedOn(INCL, '2026-09-24'));
  ok('★ 1명 이상 계획이 저장된 공휴일은 연다(사람이 연 날)', !wk.isWeekendClosedOn(SKIP, '2026-09-24', { '2026-09-24': 5 }));
  ok('★ 0명 계획은 휴무 그대로', wk.isWeekendClosedOn(SKIP, '2026-09-24', { '2026-09-24': 0 }));
}

/* ── [3] 재개일 · 다음 오픈일 ─────────────────────────────── */
console.log('\n[3] 재개일');
{
  const st = wk.weekendPublicationState(SKIP, new Date('2026-09-24T03:00:00Z'));
  ok('★★ 추석(목)에 신청이 막힌다', st.blocked === true && st.closedKind === 'holiday');
  ok('★★ 재개일 = 첫 진행일 9/28(월) — "다음 월요일" 고정 계산이 아니다', st.resumesOn === '2026-09-28');
  ok('문구가 공휴일을 말한다', /공휴일/.test(st.message) && /9\/28\(월\) 재개/.test(st.message));
  const st2 = wk.weekendPublicationState(SKIP, new Date('2026-09-24T03:00:00Z'), { '2026-09-28': 0 });
  ok('★ 0명 조절일도 건너뛴다(9/28 0명 → 9/29 재개)', st2.resumesOn === '2026-09-29');
  const sat = wk.weekendPublicationState(SKIP, new Date('2026-08-22T03:00:00Z'));
  ok('평범한 토요일은 주말 · 월요일 재개', sat.closedKind === 'weekend' && sat.resumesOn === '2026-08-24' && /주말 미게시/.test(sat.message));
  ok('★★ 카드의 다음 오픈일(nextOpenDate) — 9/23 다음은 9/28', cs.nextOpenDate(SKIP, '2026-09-23', null, null) === '2026-09-28');
  ok('★ 공휴일에 사람이 인원을 넣으면 그날이 다음 오픈일', cs.nextOpenDate(SKIP, '2026-09-23', null, { '2026-09-24': 10 }) === '2026-09-24');
}

/* ── [4] 이월 — 쉬는 날 몫 제외 ───────────────────────────── */
console.log('\n[4] 이월');
{
  const camp = o => Object.assign({ daily_limit: 30, recruit_total: 1000, start_date: null, carry_strategy: 'next', carry_mode: 'auto' }, o);
  // 9/21(월)~9/28(월) 8일 — 쉬는 날 9/24·25(추석)·26(토)·27(일) 4일. 평일 9/21~23 을 다 채움(90명).
  const carry = { startDate: '2026-09-21', today: '2026-09-28', submittedSince: 90 };
  const qSkip = cs.dailyQuota(camp({ skip_weekends: true }), 90, carry, { today: '2026-09-28', plans: null });
  const qIncl = cs.dailyQuota(camp({ skip_weekends: false }), 90, carry, { today: '2026-09-28', plans: null });
  ok('★★ 주말 제외 공고 — 쉬는 날 몫이 이월로 얹히지 않는다(9/28 = 30명)', qSkip === 30);
  ok('★ 주말 포함 공고 — 종전 그대로(이월 상한 2배 = 60명)', qIncl === 60);
  const qPlan = cs.dailyQuota(camp({ skip_weekends: true }), 90, carry, { today: '2026-09-28', plans: { '2026-09-24': 10 } });
  ok('★ 사람이 연 공휴일(10명)은 계획에 들어가 미달분이 이월된다(30 + 10)', qPlan === 40);
  const pc = cs.pendingCarry(camp({ skip_weekends: true }), { plans: null }, '2026-09-28', { startDate: '2026-09-21', submittedSince: 90 });
  ok('★★ 이월 표시(pendingCarry)도 같은 규칙 — 0명', pc === 0);
  const pcI = cs.pendingCarry(camp({ skip_weekends: false }), { plans: null }, '2026-09-28', { startDate: '2026-09-21', submittedSince: 90 });
  ok('주말 포함 공고의 이월 표시는 종전 그대로(210−90=120)', pcI === 120);
}

/* ── [5] 작업표 분배 · 발행 프리필 ─────────────────────────── */
console.log('\n[5] 작업표 분배 · 프리필');
{
  const r = wp.distributeDates({ total: 90, daily: 30, startDate: '2026-09-23', skipWeekends: true });
  ok('★★ 주말 제외 — 추석·주말을 건너뛴다(9/23 → 9/28 → 9/29)',
    r.days.map(d => d.date).join(',') === '2026-09-23,2026-09-28,2026-09-29');
  const r2 = wp.distributeDates({ total: 60, daily: 30, startDate: '2026-09-23', skipWeekends: false });
  ok('★ 주말 포함 — 공휴일에도 깐다(종전 동작)', r2.days.map(d => d.date).join(',') === '2026-09-23,2026-09-24');
  const sd = read('src/services/sheetlessDailyPlan.service.js');
  /* ★ 결정 182(2026-09-26) — 쉬는 날에 계획이 적히던 두 경로(발행 프리필·줄 삭제 계획 이동)는
     **통째로 없어졌다**(규칙이 날짜별 인원을 정하므로 아무 날에도 적지 않는다) — 검사 의미는 더 강해졌다. */
  ok('★★ 발행 시 작업표 줄 수를 계획으로 옮겨 적지 않는다(쉬는 날 포함 어느 날에도)',
    !/function prefillFromWorktable/.test(sd) && !/INSERT INTO campaign_daily_plans/.test(sd));
  const tb = read('src/services/trackB.service.js');
  const hide = tb.slice(tb.indexOf('async function _hideParticipantInTx('), tb.indexOf('async function hideWorkdeskRow('));
  ok('★★ 줄 삭제가 날짜별 계획을 옮기거나 새로 적지 않는다(쉬는 날 포함)',
    hide.length > 0 && !/UPDATE campaign_daily_plans/.test(hide) && !/INSERT INTO campaign_daily_plans/.test(hide)
    && /const planMoved = false;/.test(hide));
}

/* ── [6] 정리 도구 ─────────────────────────────────────────── */
console.log('\n[6] 정리 도구');
const cleanupP = (async () => {
  const svc = require('../src/services/closedDayPlanCleanup.service');
  ok('시스템 작성자 판정', svc.isSystemAuthor('작업표:master') && svc.isSystemAuthor('행삭제 이동:a') && !svc.isSystemAuthor('망고'));
  const rows = [
    { campaign_id: 'c1', title: 'T', skip_weekends: true, date: '2026-09-24', planned_count: 30, updated_by: '작업표:master' },
    { campaign_id: 'c1', title: 'T', skip_weekends: true, date: '2026-09-28', planned_count: 30, updated_by: '작업표:master' },   // 평일 = 대상 아님
    { campaign_id: 'c1', title: 'T', skip_weekends: true, date: '2026-09-26', planned_count: 5, updated_by: '박세희' },           // 사람 = 대상 아님(SQL이 걸러도 이중 방어)
  ];
  const log = [];
  const client = { query: async (q, p) => { log.push(q); if (/^DELETE/.test(q.trim())) return { rowCount: 1, rows: [{}] }; return { rows: [], rowCount: 0 }; }, release() {} };
  svc.__setPoolForTest({
    query: async (q) => { log.push(q); return { rows }; },
    connect: async () => client,
  });
  const pv = await svc.cleanupClosedDaySystemPlans({ confirm: false, today: '2026-09-23' });
  ok('★★ 미리보기는 쓰기 0건', pv.dryRun === true && !log.some(q => /DELETE|INSERT|UPDATE/.test(q)));
  ok('★★ 대상 = 쉬는 날 + 시스템 작성분만(평일·사람 값 제외)', pv.days === 1 && pv.campaigns[0].days[0].date === '2026-09-24');
  ok('공휴일 이름을 함께 보여준다', pv.campaigns[0].days[0].holidayName === '추석 연휴');
  log.length = 0;
  const run = await svc.cleanupClosedDaySystemPlans({ confirm: true, today: '2026-09-23', by: 'master' });
  ok('실행 시 그 날짜만 지운다', run.removed === 1 && log.filter(q => /DELETE FROM campaign_daily_plans/.test(q)).length === 1);
  ok('★ 낙관적 조건 — 인원·작성자가 바뀌었으면 안 지운다', log.some(q => /planned_count = \$3 AND updated_by = \$4/.test(q)));
  ok('★★ 지운 값을 이력에 남긴다(되돌리기 재료)', log.some(q => /closed_day_system_plan_cleanup/.test(q)));
  ok('★ SQL 이 사람 값을 애초에 고르지 않는다(작성자 접두 조건)',
    /updated_by LIKE '작업표:%'/.test(read('src/services/closedDayPlanCleanup.service.js')));
  svc.__setPoolForTest(null);

  const router = require('../src/routes/trackB.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/settings/closed-day-plan-cleanup');
  ok('★ 라우트 존재 · POST', !!(layer && layer.route.methods.post));
  const names = layer ? layer.route.stack.map(s => s.name) : [];
  ok('★★ 관리자 전용(adminOrMaster)', names.includes('authMiddleware') && names.includes('adminOrMasterMiddleware'));
})();

/* ── [7] 조절 화면 — 0명 확정 ─────────────────────────────── */
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
  getBoundingClientRect: () => ({}), querySelector: () => null, querySelectorAll: () => [],
  insertAdjacentHTML() {}, remove() {}, contains: () => true, innerHTML: '', textContent: '' });
const BODY = el();
const win = { location: { hostname: 'x' }, addEventListener() {}, confirm: () => true,
  sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null } };
const doc = { head: el(), body: el(), createElement: () => el(),
  getElementById: id => (id === 'cdpBody' ? BODY : el()),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
const NET = { overview: null, posts: [] };
const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, sessionStorage: win.sessionStorage, localStorage: win.localStorage,
  fetch: async (url, opt) => {
    if (opt && opt.method === 'POST') NET.posts.push({ url: String(url), body: JSON.parse(opt.body || '{}') });
    return { ok: true, json: async () => Object.assign({ ok: true }, NET.overview) };
  } };
sb.globalThis = sb; win.document = doc;
vm.createContext(sb);
vm.runInContext(read('../frontend/js/campaign-daily-plan.js'), sb, { filename: 'campaign-daily-plan.js' });
const CDP = sb.window.CampaignDailyPlan;

const OV = over => Object.assign({
  campaignId: 'c1', title: 'T', status: 'active', defaultDaily: 30, recruitTotal: 150, skipWeekends: true,
  startDate: '2026-09-21', today: '2026-09-23', planEnabled: true, carryMode: 'auto', carryHeld: null,
  carryAppliedSum: 0, carryPending: 0, todaySubmitted: 0, todayNaturalQuota: 30,
  scheduleDriven: false, scheduleDates: null, worktableLinked: true,
  worktableDates: ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']
    .map(d => ({ date: d, slots: 30, filled: 0 })),
  plans: [], byDateSubmitted: {}, todayUsed: 0, submittedAll: 0, rounds: [], roundsTotal: 0,
  roundsDrift: false, events: [],
}, over);

const modalP = (async () => {
  await cleanupP;
  console.log('\n[7] 조절 화면 — 0명 확정');
  NET.overview = OV();
  NET.posts = [];
  await CDP.open('c1');
  ok('★★ 공휴일 줄이 남은 날을 안내한다', /공휴일 2일<\/b>을 0명으로 확정하세요/.test(BODY.innerHTML)
    && /CampaignDailyPlan\._pinClosed\(\)/.test(BODY.innerHTML));
  ok('★ 자동 저장하지 않는다 — 열기만 해선 POST 0건', NET.posts.length === 0);
  CDP._pinClosed();
  ok('확정 후 안내가 "저장해야 반영"으로 바뀐다', /0명으로 확정했습니다/.test(BODY.innerHTML));
  await CDP._save();
  const post = NET.posts.find(x => /daily-plan/.test(x.url));
  const set = (post && post.body.set) || [];
  const at = d => { const h = set.find(x => x.date === d); return h ? h.count : null; };
  ok('★★ 추석 두 날이 명시 0 으로 저장된다(작업표 재배치 대상에 들어간다)', at('2026-09-24') === 0 && at('2026-09-25') === 0);
  ok('★★ 해제(remove)로 빠지지 않는다', !((post && post.body.remove) || []).some(d => d === '2026-09-24' || d === '2026-09-25'));
  ok('★★ 빠진 인원이 오늘·기존 진행일에 몰리지 않는다(종료일 뒤에 붙인다 — 임시 테섭 실측 회귀)',
    (at('2026-09-23') === null || at('2026-09-23') <= 30) && !set.some(x => x.count > 30));

  // ★★ 임시 테섭 실측 재현 — 작업표가 9/25 까지만 있어 부족분이 큰 공고(이월 방식 = 기본값).
  //   0명 확정의 빠진 인원이 오늘(9/23)로 몰리면 안 되고 종료일 뒤 평일에 붙어야 한다.
  NET.overview = OV({ carryStrategy: 'next', worktableDates: ['2026-09-23', '2026-09-24', '2026-09-25']
    .map(d => ({ date: d, slots: 30, filled: 0 })), plans: [{ date: '2026-09-23', count: 30, updatedBy: 'admin' }] });
  NET.posts = [];
  await CDP.open('c1');
  CDP._pinClosed();
  await CDP._save();
  const p3 = NET.posts.find(x => /daily-plan/.test(x.url));
  const s3 = (p3 && p3.body.set) || [];
  const at3 = d => { const h = s3.find(x => x.date === d); return h ? h.count : null; };
  ok('★★ 부족분이 오늘로 몰리지 않는다(오늘은 30 그대로 · 저장 대상 아님)', at3('2026-09-23') === null || at3('2026-09-23') === 30);
  ok('★★ 부족분이 종료일 뒤 평일(9/28~)에 붙는다 · 주말·공휴일엔 안 붙는다',
    at3('2026-09-28') > 0 && !s3.some(x => /2026-09-2[4-7]/.test(x.date) && x.count > 0));

  // 이미 참여자가 있는 공휴일은 그 수까지만
  NET.overview = OV({ worktableDates: OV().worktableDates.map(x => x.date === '2026-09-24' ? Object.assign({}, x, { filled: 3 }) : x) });
  NET.posts = [];
  await CDP.open('c1');
  ok('★ 참여자가 있는 공휴일은 0명 확정 대상이 아니다(안내는 1일만)', /공휴일 1일<\/b>을 0명으로 확정하세요/.test(BODY.innerHTML));
  CDP._pinClosed();
  await CDP._save();
  const p2 = NET.posts.find(x => /daily-plan/.test(x.url));
  const s2 = (p2 && p2.body.set) || [];
  ok('★★ 참여자 3명이 있는 공휴일은 3명으로 저장된다(작업표 재배치 거부 회피) · 나머지는 0',
    (s2.find(x => x.date === '2026-09-24') || {}).count === 3 && (s2.find(x => x.date === '2026-09-25') || {}).count === 0);

  // 이미 0명으로 저장된 공휴일은 대상 아님
  NET.overview = OV({ plans: [{ date: '2026-09-24', count: 0, updatedBy: '망고' }, { date: '2026-09-25', count: 0, updatedBy: '망고' }] });
  await CDP.open('c1');
  ok('★ 이미 0명으로 저장된 날은 다시 안내하지 않는다', !/0명으로 확정하세요/.test(BODY.innerHTML));

  // 주말 포함 공고는 대상 아님
  NET.overview = OV({ skipWeekends: false });
  await CDP.open('c1');
  ok('★ 주말 포함 공고에는 안내가 없다', !/0명으로 확정하세요/.test(BODY.innerHTML));

  // 저장된 인원을 사람이 0 으로 내리면 명시 0(set)
  const src = read('../frontend/js/campaign-daily-plan.js');
  ok('★★ 쉬는 날 0명은 "기본값 복귀(해제)"로 바꾸지 않는다',
    /v === baseFor\(d\) && !\(v === 0 && policyClosed\(d\)\)\) remove\.push\(d\)/.test(src));
})();

/* ── [8] 신청 관문 · 목록 배선 ─────────────────────────────── */
console.log('\n[8] 신청 관문 · 목록');
{
  const cr = read('src/routes/campaign.routes.js');
  ok('★★ 첫 관문은 레거시 공고만 판정(참여형은 계획을 보는 잠금 뒤 관문)',
    /if \(!camp\.participation_mode\) \{\n\s+const weekend = weekendPublicationState\(camp\);/.test(cr));
  ok('★★ 참여형 관문은 날짜별 계획을 넘긴다',
    /weekendPublicationState\(camp, now, countsMap\.get\(id\) && countsMap\.get\(id\)\.plans\)/.test(cr));
  ok('★★ 관리자 목록도 계획을 넘긴다(카드와 관문이 갈리지 않게)',
    /weekendPublicationState\(r, now, stateCnt && stateCnt\.plans\)/.test(cr));
  ok('카드에 쉬는 날 종류를 싣는다', (cr.match(/closedKind: /g) || []).length >= 4);
  const cards = read('../frontend/js/campaign-cards.js');
  ok('★ 카드 라벨은 서버 closedKind 로만 가른다(화면 재판정 0)', /c\.closedKind === 'holiday' \? '공휴일 미게시' : '주말 미게시'/.test(cards)
    && !/LUNAR_HOLIDAYS|holidayName\(/.test(cards));
  ok('"월요일 재개" 고정 문구가 남아 있지 않다', !/월요일 재개/.test(cards));
}

Promise.all([cleanupP, modalP]).then(() => {
  console.log(failed ? `\ncampaignHolidayClosure: FAILED (${failed})` : '\ncampaignHolidayClosure: passed');
  process.exit(failed ? 1 : 0);
}).catch(e => { console.log('  ✗ 실행 실패: ' + (e && e.stack)); process.exit(1); });
