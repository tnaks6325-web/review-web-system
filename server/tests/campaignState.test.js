/**
 * campaignState.test.js — 참여형 캠페인 상태엔진 회귀가드 (PRD §06-B, M1 완료기준)
 * 실행: node tests/campaignState.test.js
 *
 * 커버 케이스(PRD 명시):
 *  - 상태판정 표준 케이스(preopen/open/cutoff/daily_done/soft_full/closed/legacy)
 *  - 마지막 날 이중차감 방지(dailyQuota = 전일까지 누적확정 기준 고정)
 *  - recruit_total=0(무제한) 가드 — 영구 daily_done 금지
 *  - 스윕 미실행 상태에서의 카운트(유효홀드 = 시각 기준이므로 counts에 이미 반영된다는 계약)
 *  - daily_done(한도 충족형) → 홀드 만료 반환 시 open 복귀 / closed는 영속(status 기준)
 */
const assert = require('assert');
const {
  computeCampaignState,
  dailyQuota,
  timeStrToMinutes,
  kstDayStartUtc,
  kstTodayAt,
  KST_OFFSET_MS,
} = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** KST 시각으로 Date 생성 (예: kst('14:30') = 오늘이 아닌 고정일 2026-07-10 14:30 KST) */
function kst(hhmm, dateStr = '2026-07-10') {
  return new Date(new Date(`${dateStr}T${hhmm}:00+09:00`).getTime());
}

const CAMP = {
  participation_mode: true,
  status: 'active',
  window_start: '14:00',
  window_end: '16:00',
  close_buffer_min: 10,
  hold_ttl_min: 15,
  daily_limit: 20,
  recruit_total: 100,
};
const ZERO = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 };

console.log('campaignState 상태판정');

ok('레거시 공고는 엔진을 타지 않음', () => {
  assert.strictEqual(computeCampaignState({ ...CAMP, participation_mode: false }, ZERO, kst('15:00')).state, 'legacy');
});

ok('오픈 전 = preopen (회색+카운트다운)', () => {
  const r = computeCampaignState(CAMP, ZERO, kst('13:10'));
  assert.strictEqual(r.state, 'preopen');
  // opensAt = 오늘 KST 14:00
  assert.strictEqual(new Date(r.opensAt).getTime(), kst('14:00').getTime());
});

ok('시간창 내 + 여유 = open', () => {
  assert.strictEqual(computeCampaignState(CAMP, ZERO, kst('14:00')).state, 'open');
  assert.strictEqual(computeCampaignState(CAMP, ZERO, kst('15:49')).state, 'open');
});

ok('종료 10분 전 = cutoff (신규신청만 차단)', () => {
  assert.strictEqual(computeCampaignState(CAMP, ZERO, kst('15:50')).state, 'cutoff');
  assert.strictEqual(computeCampaignState(CAMP, ZERO, kst('15:59')).state, 'cutoff');
});

ok('시간창 종료 = daily_done', () => {
  assert.strictEqual(computeCampaignState(CAMP, ZERO, kst('16:00')).state, 'daily_done');
  assert.strictEqual(computeCampaignState(CAMP, ZERO, kst('23:59')).state, 'daily_done');
});

ok('일일한도 충족 = daily_done (분자 = 오늘 유효홀드 + 오늘 제출)', () => {
  const counts = { ...ZERO, todayActiveHolds: 5, todaySubmitted: 15 };
  assert.strictEqual(computeCampaignState(CAMP, counts, kst('14:30')).state, 'daily_done');
});

ok('작업표 오늘 채움 30/30 = daily_done (공고 신청 집계가 적어도 카드·게이트 일치)', () => {
  const counts = { ...ZERO, todaySubmitted: 4, tableTodayFilled: 30 };
  const st = computeCampaignState({ ...CAMP, daily_limit: 30 }, counts, kst('14:30'));
  assert.strictEqual(st.todayCount, 30);
  assert.strictEqual(st.state, 'daily_done');
});

ok('작업표 수 미전달이면 종전 공고 신청 집계로 유지', () => {
  const counts = { ...ZERO, todaySubmitted: 4 };
  assert.strictEqual(computeCampaignState({ ...CAMP, daily_limit: 30 }, counts, kst('14:30')).state, 'open');
});

ok('홀드 만료 반환 시 daily_done → open 복귀 (역전이)', () => {
  // 20/20 이었다가 홀드 3건 만료(시각 기준으로 counts에서 빠짐) → 17/20 → open
  const counts = { ...ZERO, todayActiveHolds: 2, todaySubmitted: 15 };
  assert.strictEqual(computeCampaignState(CAMP, counts, kst('14:30')).state, 'open');
});

ok('soft_full: 누적제출+유효홀드 ≥ 총모집 → 신청만 차단 (종착 아님)', () => {
  // 주의: 홀드는 당일 생성·당일 만료라 실운영에선 대개 daily_done(일일한도)이 먼저 걸린다.
  //   soft_full은 그 가정이 깨진 경우(카운트 드리프트·수동 확정 등)의 방어 분기 — 총모집 초과 신청을 막는 최후 게이트.
  const counts = { ...ZERO, submittedAll: 95, activeHolds: 5, todaySubmitted: 3, todayActiveHolds: 2, submittedBeforeToday: 92 };
  assert.strictEqual(computeCampaignState(CAMP, counts, kst('14:30')).state, 'soft_full');
  // 홀드 2건 만료 → usedAll 98 < 100 → 다시 열림
  const counts2 = { ...counts, activeHolds: 3 };
  assert.strictEqual(computeCampaignState(CAMP, counts2, kst('14:30')).state, 'open');
});

ok('closed는 영속 status 기준 (엔진이 계산으로 closed를 만들지 않음)', () => {
  const r = computeCampaignState({ ...CAMP, status: 'closed' }, ZERO, kst('14:30'));
  assert.strictEqual(r.state, 'closed');
});

console.log('dailyQuota — 이중차감 방지·가드');

ok('마지막 날 잔여 축소: 분모 = min(20, 100-93) = 7 (일 시작 시점 고정)', () => {
  assert.strictEqual(dailyQuota(CAMP, 93), 7);
});

ok('이중차감 금지: 오늘 5건 확정돼도 분모 불변(7), 분자만 증가', () => {
  // recruit_total=100, 전일까지 93 확정, 오늘 5건 확정 → quota 는 여전히 7 (min(20, 100-93))
  // (결함 케이스: quota=min(20,100-98)=2 로 줄어 today 5>=2 조기 daily_done — 금지)
  const counts = { ...ZERO, submittedBeforeToday: 93, submittedAll: 98, todaySubmitted: 5, todayActiveHolds: 0 };
  const r = computeCampaignState(CAMP, counts, kst('14:30'));
  assert.strictEqual(r.dailyQuota, 7);
  assert.strictEqual(r.state, 'open'); // 5 < 7 — 아직 열려 있어야 함
});

ok('recruit_total=0(무제한) 가드: quota = daily_limit (영구 daily_done 금지)', () => {
  const c = { ...CAMP, recruit_total: 0 };
  assert.strictEqual(dailyQuota(c, 0), 20);
  assert.strictEqual(computeCampaignState(c, ZERO, kst('14:30')).state, 'open');
});

// ★ 총원 소진은 **soft_full**(총 모집 마감)이지 daily_done(오늘만 마감)이 아니다.
//   순서가 반대였을 때 quota 0 → todayCount(0) >= quota(0) 이 먼저 참이 되어
//   다 모집한 캠페인이 매일 "내일 다시 오픈"으로 표시됐다(7/31 올리브영 건).
//   두 상태 모두 apply 차단이라 참여 동작은 동일 — 바뀌는 건 표시 문구뿐.
ok('전량 소진 → soft_full (quota 0에서도 "내일 다시 오픈"으로 보이지 않는다)', () => {
  assert.strictEqual(dailyQuota(CAMP, 100), 0);
  const counts = { ...ZERO, submittedBeforeToday: 100, submittedAll: 100 };
  assert.strictEqual(computeCampaignState(CAMP, counts, kst('14:30')).state, 'soft_full');
});

ok('총원 미달이면 종전대로 오늘 한도로 판정(daily_done)', () => {
  const counts = { ...ZERO, submittedBeforeToday: 79, submittedAll: 99, todaySubmitted: 20 };
  assert.strictEqual(computeCampaignState(CAMP, counts, kst('14:30')).state, 'daily_done');
});

console.log('시간 유틸');

ok('timeStrToMinutes 파싱·검증', () => {
  assert.strictEqual(timeStrToMinutes('14:00'), 840);
  assert.strictEqual(timeStrToMinutes('14:00:00'), 840);
  assert.strictEqual(timeStrToMinutes('25:00'), null);
  assert.strictEqual(timeStrToMinutes(''), null);
});

ok('kstDayStartUtc: KST 자정 = UTC 전일 15:00', () => {
  const d = kstDayStartUtc(kst('01:30'));
  assert.strictEqual(d.toISOString(), '2026-07-09T15:00:00.000Z');
});

ok('kstTodayAt: 오늘 KST 14:00 → UTC 05:00', () => {
  const d = kstTodayAt('14:00', kst('09:00'));
  assert.strictEqual(d.toISOString(), '2026-07-10T05:00:00.000Z');
});

ok('시간창 미설정/역전은 참여 불가(closed) 방어', () => {
  assert.strictEqual(computeCampaignState({ ...CAMP, window_start: null }, ZERO, kst('14:30')).state, 'closed');
  assert.strictEqual(computeCampaignState({ ...CAMP, window_start: '16:00', window_end: '14:00' }, ZERO, kst('14:30')).state, 'closed');
});

ok("timeStrToMinutes('24:00') = 1440 (PG TIME 자정 종료 창 — 무신호 closed 위장 방지)", () => {
  assert.strictEqual(timeStrToMinutes('24:00'), 1440);
  assert.strictEqual(timeStrToMinutes('24:00:00'), 1440);
  assert.strictEqual(timeStrToMinutes('24:01'), null);
});

/* ── 자율주문(종일 오픈) — 시간창 양쪽 미설정 정식 지원 ── */
ok('자율주문: 시간창 양쪽 미설정 = 종일 open (allDay 신호, 새벽에도 open)', () => {
  const c = { ...CAMP, window_start: null, window_end: null };
  const st = computeCampaignState(c, ZERO, kst('15:00'));
  assert.strictEqual(st.state, 'open');
  assert.strictEqual(st.allDay, true);
  assert.strictEqual(st.opensAt, null);
  assert.strictEqual(st.closesAt, null);
  assert.strictEqual(computeCampaignState(c, ZERO, kst('02:00')).state, 'open'); // preopen·cutoff 없음
});

ok('자율주문: 일일한도·총모집 게이트는 동일 작동(daily_done/soft_full)', () => {
  const c = { ...CAMP, window_start: null, window_end: null };
  assert.strictEqual(computeCampaignState(c, { ...ZERO, todaySubmitted: 20 }, kst('15:00')).state, 'daily_done');
  assert.strictEqual(
    computeCampaignState(c, { ...ZERO, submittedAll: 95, activeHolds: 5, todaySubmitted: 3 }, kst('15:00')).state,
    'soft_full');
});

ok('자율주문: closed 영속·비활성은 동일(closed 우선)', () => {
  const c = { ...CAMP, window_start: null, window_end: null, status: 'closed' };
  assert.strictEqual(computeCampaignState(c, ZERO, kst('15:00')).state, 'closed');
});

/* ── 시작일(start_date, migration 062) — 시작일 전 게시 = 날짜 preopen ── */
ok('시작일: KST 오늘 < start_date → preopen + opensAt=시작일의 window_start 시각', () => {
  const c = { ...CAMP, start_date: '2026-07-12' };
  const st = computeCampaignState(c, ZERO, kst('15:00')); // 시간창 안 시각이어도 날짜 게이트가 우선
  assert.strictEqual(st.state, 'preopen');
  assert.strictEqual(st.opensAt, '2026-07-12T05:00:00.000Z'); // 7/12 KST 14:00
  assert.strictEqual(st.startDate, '2026-07-12');
});

ok('시작일: 자율주문 + 미래 시작일 → preopen(그날 KST 자정 오픈), 도달 후 open', () => {
  const c = { ...CAMP, window_start: null, window_end: null, start_date: '2026-07-12' };
  const st = computeCampaignState(c, ZERO, kst('15:00'));
  assert.strictEqual(st.state, 'preopen');
  assert.strictEqual(st.opensAt, '2026-07-11T15:00:00.000Z'); // 7/12 KST 00:00
  assert.strictEqual(computeCampaignState(c, ZERO, kst('00:10', '2026-07-12')).state, 'open');
});

ok('시작일: 오늘/과거 시작일·pg Date 객체 입력은 동작 불변(창 안=open)', () => {
  assert.strictEqual(computeCampaignState({ ...CAMP, start_date: '2026-07-10' }, ZERO, kst('14:30')).state, 'open');
  assert.strictEqual(computeCampaignState({ ...CAMP, start_date: new Date('2026-07-01T00:00:00Z') }, ZERO, kst('14:30')).state, 'open');
  assert.strictEqual(computeCampaignState({ ...CAMP, start_date: new Date('2026-07-12T00:00:00Z') }, ZERO, kst('14:30')).state, 'preopen');
});

ok('한쪽만 설정된 시간창은 여전히 closed + window_invalid (설정 오류 방어)', () => {
  const st = computeCampaignState({ ...CAMP, window_start: null }, ZERO, kst('15:00'));
  assert.strictEqual(st.state, 'closed');
  assert.strictEqual(st.stateReason, 'window_invalid');
  const st2 = computeCampaignState({ ...CAMP, window_end: null }, ZERO, kst('15:00'));
  assert.strictEqual(st2.state, 'closed');
  assert.strictEqual(st2.stateReason, 'window_invalid');
});

ok('스윕 미실행 계약: 만료 홀드는 counts 집계 조건(expires_at>now)에서 이미 제외', () => {
  // fetchCampaignCounts의 SQL 이 status='applied' AND expires_at > NOW() 를 사용하므로
  // 순수 함수에는 "유효 홀드"만 도달한다 — 여기서는 그 계약을 상태 전이로 재확인.
  const full = { ...ZERO, todayActiveHolds: 20 };
  assert.strictEqual(computeCampaignState(CAMP, full, kst('14:30')).state, 'daily_done');
  const afterExpiry = { ...ZERO, todayActiveHolds: 0 };
  assert.strictEqual(computeCampaignState(CAMP, afterExpiry, kst('14:30')).state, 'open');
});

console.log(`\n✅ campaignState.test.js — ${passed} cases passed`);
