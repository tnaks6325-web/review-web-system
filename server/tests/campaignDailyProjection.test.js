/**
 * campaignDailyProjection.test.js — 날짜별 예상 모집 인원 + 「남은 날에 나눠 담기」 쉬는 날 계산 (2026-09-26).
 *
 * 배경(사용자 확정 2026-09-26): 날짜별 인원은 "일건수·주말·이월 규칙이 정하고 작업표가 따라간다".
 *   그 규칙의 단일 출처 = 실제 정원 판정(dailyQuota). 예상 인원(projectDailyQuotas)은 그 판정을
 *   날마다 그대로 불러 만든다 — 화면·작업표가 앞날 인원을 따로 계산하지 않게 한다.
 * 고정:
 *   [1] 세 이월 방식 모두 예상 합계 = 남은 인원(총량 − 어제까지 확정) · 쉬는 날 0
 *   [2] 「남은 날에 나눠 담기」가 쉬는 날(주말·공휴일)을 진행일로 세지 않는다(종전 식은 40, 바른 값 35)
 *   [3] 사람이 정한 날(0명 포함)·사람이 연 주말은 그 값 그대로
 *   [4] 하루 상한(일건수 2배) — 넘친 이월은 다음 진행일로 넘어간다
 *   [5] 시작일이 미래·무제한·일건수 0·시트 일정·레거시 — 지어내지 않는다
 *   [6] 모집인원 조절 창 재료(getPlanOverview)가 같은 함수를 싣는다
 * 실행: node tests/campaignDailyProjection.test.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../src/services/campaignState.service');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

// 2026-09-28(월) KST 10:00. 9/24~9/26 추석 연휴, 10/3 개천절(토), 10/9 한글날(금).
const NOW = new Date('2026-09-28T01:00:00Z');
const camp = o => Object.assign({
  id: 'c1', participation_mode: true, status: 'active', daily_limit: 30, recruit_total: 300,
  start_date: '2026-09-21', skip_weekends: true, carry_mode: 'auto', carry_strategy: 'next',
}, o);
// 9/21~9/23 진행 3일(= 90명 계획) 중 60명 확정 → 이월 30
const counts = o => Object.assign({
  submittedBeforeToday: 60, submittedAll: 60, todaySubmitted: 0, activeHolds: 0, todayActiveHolds: 0,
  carry: { startDate: '2026-09-01', submittedSince: 60 }, plans: null,
}, o);
const sum = p => p.days.reduce((a, x) => a + x.quota, 0);
const q = (p, d) => { const x = p.days.find(y => y.date === d); return x ? x.quota : null; };

console.log('[1] 세 이월 방식 — 합계 = 남은 인원 · 쉬는 날 0');
for (const st of ['next', 'spread', 'extend']) {
  const p = S.projectDailyQuotas(camp({ carry_strategy: st }), counts(), { now: NOW });
  ok(`${st}: 예상 합계(${sum(p)}) = 남은 인원(${p.remaining})`, p && sum(p) === 240 && p.remaining === 240);
  ok(`${st}: 토·일·개천절은 0 이고 쉬는 날로 표시`, q(p, '2026-10-03') === 0 && q(p, '2026-10-04') === 0
    && p.days.find(x => x.date === '2026-10-03').closed === true);
}
{
  const nx = S.projectDailyQuotas(camp(), counts(), { now: NOW });
  ok('next: 오늘에 이월 30을 얹어 60', q(nx, '2026-09-28') === 60);
  ok('next: 예상 종료일 10/6', nx.endDate === '2026-10-06');
  const ex = S.projectDailyQuotas(camp({ carry_strategy: 'extend' }), counts(), { now: NOW });
  ok('extend: 어느 날도 일건수(30)를 넘지 않는다', ex.days.every(x => x.quota <= 30));
  ok('extend: 이월만큼 종료일이 하루 밀린다(10/7)', ex.endDate === '2026-10-07');
}

console.log('[2] 남은 날에 나눠 담기 — 쉬는 날을 진행일로 세지 않는다');
{
  const c = camp({ carry_strategy: 'spread' });
  const today = S.dailyQuota(c, 60, { startDate: '2026-09-01', today: '2026-09-28', submittedSince: 60 },
    { today: '2026-09-28', plans: null });
  // 원래 종료일 10/6 까지 남은 진행일 = 9/28,29,30,10/1,2,5,6 = 7일 → 30 + ceil(30/7) = 35
  ok(`오늘 몫 = 35 (종전 식은 연휴를 진행일로 세어 40) — 실제 ${today}`, today === 35);
  const sp = S.projectDailyQuotas(c, counts(), { now: NOW });
  ok('spread: 어느 날도 35를 넘지 않고 원래 종료일(10/6)에 끝난다', sp.days.every(x => x.quota <= 35) && sp.endDate === '2026-10-06');
  // 큰 미달분: 상한 전 미달분으로 나눈 뒤 상한(60)을 건다
  const big = S.dailyQuota(c, 0, { startDate: '2026-09-01', today: '2026-09-28', submittedSince: 0 },
    { today: '2026-09-28', plans: null });
  ok(`큰 미달분도 하루 상한(60)을 넘지 않는다 — 실제 ${big}`, big <= 60 && big >= 30);
  // 원래 종료일이 이미 지난 공고: 나눌 날이 1일이라 상한이 없으면 수백 명이 한 날에 열린다
  const late = S.dailyQuota(camp({ carry_strategy: 'spread', start_date: '2026-08-03' }), 0,
    { startDate: '2026-08-01', today: '2026-09-28', submittedSince: 0 }, { today: '2026-09-28', plans: null });
  ok(`원래 종료일이 지난 뒤에도 하루 상한(60) — 실제 ${late}`, late === 60);
}

console.log('[3] 사람이 정한 날');
{
  const plans = { '2026-09-29': 10, '2026-09-30': 0, '2026-10-03': 20 };
  const p = S.projectDailyQuotas(camp({ carry_strategy: 'extend' }), counts({ plans }), { now: NOW });
  ok('10명으로 정한 날 = 10 · 계획값 표시', q(p, '2026-09-29') === 10 && p.days.find(x => x.date === '2026-09-29').planned === 10);
  ok('0명으로 정한 날 = 0 · 쉬는 날로 표시', q(p, '2026-09-30') === 0 && p.days.find(x => x.date === '2026-09-30').closed === true);
  ok('사람이 연 토요일(개천절) = 20', q(p, '2026-10-03') === 20);
  ok('그래도 합계 = 남은 인원(종료일이 늘어난다)', sum(p) === 240);
}

console.log('[4] 하루 상한 — 넘친 이월은 다음 진행일로');
{
  // 9/21~23 계획 90 중 0명 확정 → 이월 90
  const p = S.projectDailyQuotas(camp(), counts({ submittedBeforeToday: 0, submittedAll: 0, carry: { startDate: '2026-09-01', submittedSince: 0 } }), { now: NOW });
  ok('오늘은 상한 60', q(p, '2026-09-28') === 60);
  ok('남은 이월이 다음 날로 넘어간다(60)', q(p, '2026-09-29') === 60);
  ok('합계 = 300', sum(p) === 300);
  ok('총량을 다 채운 날에서 멈춘다(뒤에 빈 날을 잇지 않는다)', !p.truncated && p.days[p.days.length - 1].date === p.endDate);
}

console.log('[5] 지어내지 않는다');
{
  const fut = S.projectDailyQuotas(camp({ start_date: '2026-10-05' }), counts({ submittedBeforeToday: 0, submittedAll: 0,
    carry: { startDate: '2026-09-01', submittedSince: 0 } }), { now: NOW });
  ok('시작일이 미래면 시작일부터', fut.from === '2026-10-05' && fut.days[0].date === '2026-10-05');
  const un = S.projectDailyQuotas(camp({ recruit_total: 0 }), counts(), { now: NOW, maxDays: 20 });
  ok('무제한: 종료일 없음 · 남은 인원 없음 · 잘림 표시', un.endDate === null && un.remaining === null && un.truncated === true);
  const z = S.projectDailyQuotas(camp({ daily_limit: 0 }), counts(), { now: NOW });
  ok('일건수 0·계획 없음: 끝없이 돌지 않는다', z && z.days.length <= 1);
  ok('레거시 공고 = null', S.projectDailyQuotas(camp({ participation_mode: false }), counts(), { now: NOW }) === null);
  const sch = { ok: true, firstDate: '2026-09-28', lastDate: '2026-09-29', totalSlots: 60,
    byDate: { '2026-09-28': 30, '2026-09-29': 30 }, dates: [{ date: '2026-09-28', slots: 30 }, { date: '2026-09-29', slots: 30 }] };
  ok('(전제) 시험용 일정이 실제로 쓰이는 일정으로 판정된다', S.isUsableSchedule(sch));
  ok('시트 일정 공고 = null', S.projectDailyQuotas(camp(), counts(), { now: NOW, schedule: sch }) === null);
}

console.log('[6] 모집인원 조절 창 재료');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/services/campaignPlan.service.js'), 'utf8');
  ok('getPlanOverview 가 같은 함수(projectDailyQuotas)로 예상 인원을 만든다', /projection = projectDailyQuotas\(camp, counts, \{ schedule: sch \}\)/.test(src));
  ok('응답에 projection 을 싣는다', /\n    projection,\n/.test(src));
  ok('계산 실패는 null(0 으로 꾸미지 않는다)', /catch \(pe\) \{ projection = null;/.test(src));
}

console.log(failed ? `campaignDailyProjection: FAILED (${failed}/${n})` : `campaignDailyProjection: passed (${n})`);
process.exit(failed ? 1 : 0);
