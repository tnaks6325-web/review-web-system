/**
 * campaignSchedule.test.js — 시트 일정 자동 인식(063) 단위 테스트
 *   ① 한국식 날짜 파서(실측 표기 2종 혼재 + 연도 추론)
 *   ② 일정 요약(시작일·마감일·날짜별 정원)
 *   ③ 상태엔진 통합(이월·휴무일·마감일·자동 재개)
 * 실행: node tests/campaignSchedule.test.js
 */
const assert = require('assert');
const { parseDateToken, parseDateColumn } = require('../src/utils/koreanDate');
const { summarizeDates, findDateColumnIndex } = require('../src/services/campaignSchedule.service');
const { computeCampaignState, plannedThrough, nextWorkDate } = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }
const kst = (s) => new Date(`${s}+09:00`);

console.log('① 날짜 파서');

ok('실측 표기 2종 — 연도 있는 YY.M.D(요일), 연도 없는 M / D (요일)', () => {
  assert.deepStrictEqual(parseDateToken('26.7.28(화)'), { y: 2026, m: 7, d: 28 });
  assert.deepStrictEqual(parseDateToken('7 / 23 (목)'), { y: null, m: 7, d: 23 });
});

ok('기타 표기 — YYYY-MM-DD / YYYY.M.D / 한글 / 시트 일련번호', () => {
  assert.deepStrictEqual(parseDateToken('2026-07-24'), { y: 2026, m: 7, d: 24 });
  assert.deepStrictEqual(parseDateToken('2026.7.24'), { y: 2026, m: 7, d: 24 });
  assert.deepStrictEqual(parseDateToken('2026년 7월 24일'), { y: 2026, m: 7, d: 24 });
  assert.deepStrictEqual(parseDateToken('46226'), { y: 2026, m: 7, d: 23 });
});

ok('날짜가 아닌 값은 null — 번호·텍스트·빈칸·존재하지 않는 날짜', () => {
  for (const v of ['', null, undefined, '24', '입금완료', '비고', '2026-02-30', '13/45']) {
    assert.strictEqual(parseDateToken(v), null, String(v));
  }
});

ok('연도 추론: 연도 없는 값은 인접한 연도 확정 값을 앵커로 삼는다(실측 배열 재현)', () => {
  const col = ['7 / 23 (목)', '7 / 24 (금)', '26.7.28(화)', '26.7.29(수)'];
  assert.deepStrictEqual(parseDateColumn(col), ['2026-07-23', '2026-07-24', '2026-07-28', '2026-07-29']);
});

ok('연도 추론: 연말연초 경계 보정(앵커 1월 · 값 12월 → 전년)', () => {
  assert.deepStrictEqual(parseDateColumn(['12/30', '12/31', '27.1.2']), ['2026-12-30', '2026-12-31', '2027-01-02']);
});

ok('앵커가 하나도 없으면 fallbackAnchor로 추론, 그것도 없으면 null', () => {
  assert.deepStrictEqual(parseDateColumn(['7/1', '7/2'], { fallbackAnchor: { y: 2026, m: 7 } }), ['2026-07-01', '2026-07-02']);
  assert.deepStrictEqual(parseDateColumn(['7/1', '7/2']), [null, null]);
});

console.log('\n② 일정 요약');

ok('시작일=최소 · 마감일=최대 · 날짜별 정원=행 수 · 총건수=행 합', () => {
  const s = summarizeDates(['2026-07-23', '2026-07-23', '2026-07-24', null, '2026-07-27'], 5);
  assert.strictEqual(s.firstDate, '2026-07-23');
  assert.strictEqual(s.lastDate, '2026-07-27');
  assert.strictEqual(s.totalSlots, 4);
  assert.deepStrictEqual(s.byDate, { '2026-07-23': 2, '2026-07-24': 1, '2026-07-27': 1 });
});

ok('신뢰 조건 미달이면 null — 날짜 1종 이하 / 파싱 성공률 60% 미만', () => {
  assert.strictEqual(summarizeDates(['2026-07-23', '2026-07-23'], 2), null);       // 날짜 1종
  assert.strictEqual(summarizeDates(['2026-07-23', '2026-07-24', null, null, null, null], 6), null); // 33%
});

ok('날짜 컬럼 탐지 — 구매일자/시작일 계열', () => {
  assert.strictEqual(findDateColumnIndex(['번호', '담당자', '구매일자', '수취인']), 2);
  assert.strictEqual(findDateColumnIndex(['번호', '수취인', '연락처']), -1);
});

/* ★★ 운영 실측(2026-08-07): 105탭 중 14탭이 `구매날짜` 표기였는데 '구매일' 을 포함하지 않아
 *    날짜 칸으로 인식되지 않았다 → 탈시트 이관 점검이 "준비 줄을 셀 수 없음"으로 잠기고
 *    시트 일정 자동 인식(063)도 그 탭들에서 한 번도 걸리지 않았다. */
ok('★★ `구매날짜` 표기도 날짜 칸으로 인식한다(실측 14탭)', () => {
  assert.strictEqual(findDateColumnIndex(['번호', '차수', '담당', '구매날짜', '연락처']), 3);
  assert.strictEqual(findDateColumnIndex(['번호', '구매 날짜', '연락처']), 1);
});

/* ★★ 넓히면 안 되는 방향 — `findDateColumnIndex` 는 **가장 앞선 매칭**을 쓰므로 '날짜'·'일자' 를
 *    키워드로 넣으면 `입금일자`·`리뷰날짜` 를 구매일로 오인해 그날 정원이 통째로 틀어진다. */
ok('★★ 입금·리뷰 계열 날짜 칸은 구매일로 인식하지 않는다(완화 금지)', () => {
  assert.strictEqual(findDateColumnIndex(['번호', '입금일자', '리뷰날짜', '연락처']), -1);
  // 구매 칸이 뒤에 있어도 앞의 입금/리뷰 칸을 집지 않는다
  assert.strictEqual(findDateColumnIndex(['입금일자', '리뷰날짜', '구매날짜']), 2);
});

console.log('\n③ 상태엔진 통합');

// 실측 형태의 축소 일정: 7/23(2) 7/24(5) 7/27(3) — 7/25·7/26은 휴무(행 없음)
const SCHED = summarizeDates(
  ['2026-07-23', '2026-07-23', '2026-07-24', '2026-07-24', '2026-07-24', '2026-07-24', '2026-07-24',
   '2026-07-27', '2026-07-27', '2026-07-27'], 10);
const CAMP = { participation_mode: true, status: 'active', window_start: null, window_end: null,
  close_buffer_min: 10, hold_ttl_min: 15, daily_limit: 20, recruit_total: 999 };
const ZERO = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 };

ok('시작일 전 = preopen (시트 최소 날짜가 시작일)', () => {
  const st = computeCampaignState(CAMP, ZERO, kst('2026-07-22T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'preopen');
  assert.strictEqual(st.startDate, '2026-07-23');
  assert.strictEqual(st.endDate, '2026-07-27');
});

ok('마감일 = 시트 최대 날짜. 경과하면 closed + schedule_ended', () => {
  const st = computeCampaignState(CAMP, ZERO, kst('2026-07-28T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'closed');
  assert.strictEqual(st.stateReason, 'schedule_ended');
});

ok('그날 정원 = 그 날짜 행 수 (발행폼 daily_limit 20이 아니라 시트 2건)', () => {
  const st = computeCampaignState(CAMP, ZERO, kst('2026-07-23T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'open');
  assert.strictEqual(st.dailyQuota, 2);
  assert.strictEqual(st.totalSlots, 10);
});

ok('이월: 전날 미달분이 다음 진행일 정원에 합산된다', () => {
  // 7/23에 2건 계획인데 0건만 확정 → 7/24 정원 = (2+5) − 0 = 7
  const st = computeCampaignState(CAMP, { ...ZERO, submittedBeforeToday: 0 }, kst('2026-07-24T10:00:00'), SCHED);
  assert.strictEqual(st.dailyQuota, 7);
  // 7/23을 다 채웠으면 7/24 정원 = (2+5) − 2 = 5
  const st2 = computeCampaignState(CAMP, { ...ZERO, submittedBeforeToday: 2 }, kst('2026-07-24T10:00:00'), SCHED);
  assert.strictEqual(st2.dailyQuota, 5);
});

ok('휴무일(시트에 그 날짜 행 0개)은 열지 않고 다음 진행일 + 카운트다운을 안내', () => {
  const st = computeCampaignState(CAMP, ZERO, kst('2026-07-25T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'daily_done');
  assert.strictEqual(st.stateReason, 'rest_day');
  assert.strictEqual(st.nextWorkDate, '2026-07-27');
  assert.strictEqual(st.opensAt, '2026-07-26T15:00:00.000Z');   // 7/27 KST 00:00
});

ok('휴무일에도 이월분은 보존된다 — 다음 진행일 정원에 그대로 합산', () => {
  // 7/25(휴무) 다음 진행일 7/27: 계획 누적(2+5+3)=10 − 전일까지 확정 1 = 9
  const st = computeCampaignState(CAMP, { ...ZERO, submittedBeforeToday: 1 }, kst('2026-07-27T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'open');
  assert.strictEqual(st.dailyQuota, 9);
});

ok('총 건수 소진 시 soft_full — 총건수도 시트 행 수가 기준', () => {
  const st = computeCampaignState(CAMP, { ...ZERO, submittedAll: 10, submittedBeforeToday: 1 },
    kst('2026-07-27T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'soft_full');
});

ok('★ 사용자 시나리오: 마감 후 새 날짜가 추가되면 다시 오픈 예정으로 인식', () => {
  // 7/27로 끝난 캠페인을 7/29에 조회 → 종료
  const ended = computeCampaignState(CAMP, ZERO, kst('2026-07-29T10:00:00'), SCHED);
  assert.strictEqual(ended.stateReason, 'schedule_ended');
  // 시트에 8/1부터 새 날짜 10개(각 5건)를 추가 → 같은 시점 조회가 preopen(8/1 오픈)으로 전환
  const added = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    for (let k = 0; k < 5; k++) added.push(d);
  }
  const grown = summarizeDates(
    [...SCHED.dates.flatMap(x => Array(x.slots).fill(x.date)), ...added], 60);
  const st = computeCampaignState(CAMP, ZERO, kst('2026-07-29T10:00:00'), grown);
  assert.strictEqual(st.stateReason, 'rest_day');           // 종료가 풀리고 "다음 진행일 대기"로 전환
  assert.strictEqual(st.nextWorkDate, '2026-08-01');        // 새 블록 첫날
  assert.strictEqual(st.opensAt, '2026-07-31T15:00:00.000Z'); // 8/1 KST 00:00 카운트다운
  assert.strictEqual(st.endDate, '2026-08-10');             // 마감일이 새 날짜로 연장
  assert.strictEqual(st.startDate, '2026-07-23');           // 최초 시작일은 유지
});

ok('일정이 없으면(못 읽으면) 기존 발행폼 값으로 동작 — 회귀 방지', () => {
  const st = computeCampaignState(CAMP, ZERO, kst('2026-07-24T10:00:00'), null);
  assert.strictEqual(st.state, 'open');
  assert.strictEqual(st.dailyQuota, 20);            // daily_limit 그대로
  assert.strictEqual(st.endDate, undefined);
  assert.strictEqual(st.scheduleSource, undefined);
});

ok('일정이 있어도 status가 active가 아니면 closed 우선(관리자 수동 마감 존중)', () => {
  const st = computeCampaignState({ ...CAMP, status: 'closed' }, ZERO, kst('2026-07-24T10:00:00'), SCHED);
  assert.strictEqual(st.state, 'closed');
});

ok('보조 함수: plannedThrough 누적 · nextWorkDate 다음 진행일', () => {
  assert.strictEqual(plannedThrough(SCHED, '2026-07-24'), 7);
  assert.strictEqual(plannedThrough(SCHED, '2026-07-22'), 0);
  assert.strictEqual(nextWorkDate(SCHED, '2026-07-24'), '2026-07-27');
  assert.strictEqual(nextWorkDate(SCHED, '2026-07-27'), null);
});

console.log(`\n✅ campaignSchedule.test.js — ${passed} cases passed`);
