'use strict';
/**
 * 총 인원 불변식 — 이월이 어떻게 계산되든 총 인원을 넘지 않는다 (사용자 지적 2026-09-26)
 *
 * 사고: 닥터바실리온(총 100 · 일건수 100 · 9/22 시작 · 확정 34)의 [📅 인원] 이월 칩이 **366명**(= 100×4일 − 34).
 *   실제 정원(dailyQuota)은 총원으로 잘려 모집이 넘치지는 않았지만, 이월 표시·카드 ⏸ 칩·「보류 이월 반영」 제안이
 *   남은 자리를 몰랐다(운영 20개 공고 중 13개).
 * 고정(무작위 조합 수백 개 + 실사례 재현):
 *   ① 이월(pendingCarry)·보류 잔량(heldCarry) ≤ 남은 자리(총 − 확정)
 *   ② 오늘 정원(dailyQuota) ≤ 총 − 어제까지 확정
 *   ③ 앞날 예상 인원(projectDailyQuotas) 합 + 어제까지 확정 ≤ 총 인원 · 하루도 음수 없음
 *   세 이월 방식(next·spread·extend) + 보류(hold) · 주말 제외/포함 · 사람이 정한 날 · 일건수 ≥ 총 인원 모두.
 * 실행: node tests/carryTotalInvariant.test.js
 */
const assert = require('assert');
const S = require('../src/services/campaignState.service');

let passed = 0;
const ok = (n, c, x) => { assert.ok(c, n + (x ? ' :: ' + x : '')); passed++; };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// KST 정오 고정(날짜 경계 흔들림 없음)
const NOW = new Date('2026-09-26T03:00:00Z');
const TODAY = S.kstTodayStr(NOW);

function camp(o) {
  return Object.assign({ id: 'c', participation_mode: true, status: 'active', recruit_total: 100, daily_limit: 10,
    start_date: addDays(TODAY, -4), carry_strategy: 'next', carry_mode: 'auto', skip_weekends: false,
    window_start: null, window_end: null }, o);
}
function counts(o) {
  const before = o.before, today = o.today || 0;
  return {
    submittedAll: before + today, todaySubmitted: today, submittedBeforeToday: before, activeHolds: 0, todayActiveHolds: 0,
    carry: { startDate: o.carryStart || addDays(TODAY, -30), today: TODAY, submittedSince: before },
    hold: { startDate: o.carryStart || addDays(TODAY, -30), submittedSince: before },
    plans: o.plans || null,
  };
}

console.log('[1] 실사례 재현 — 닥터바실리온');
{
  const c = camp({ recruit_total: 100, daily_limit: 100, start_date: '2026-09-22', carry_strategy: 'extend' });
  const cnt = counts({ before: 34, carryStart: '2026-09-22' });
  const pc = S.pendingCarry(c, cnt, TODAY, cnt.carry);
  ok('★★ 이월 = 남은 자리 66 (종전 366)', pc === 66, String(pc));
  const q = S.dailyQuota(c, 34, cnt.carry, { today: TODAY, plans: null });
  ok('오늘 정원도 66(종전과 같음 — 실제 모집은 원래 잘렸다)', q === 66, String(q));
  const held = S.heldCarry({ ...c, carry_mode: 'hold' }, cnt, TODAY, 0);
  ok('★ 보류 공고였다면 반영 제안도 66 이하', held != null && held <= 66, String(held));
  console.log('  ✓ 이월 366 → 66 · 오늘 정원 66 · 보류 반영 ≤ 66');
}

console.log('[1b] 보류 — 반영분을 뺀 뒤 자른다(Codex 리뷰: 먼저 자르면 빈자리를 적게·0 으로 말한다)');
{
  // 총 100 · 확정 34(남은 66) · 부족분 큼 · 예전에 20명 반영했지만 그날이 지나도록 안 찼다(계획에 이미 포함)
  const c = camp({ recruit_total: 100, daily_limit: 100, start_date: '2026-09-22', carry_mode: 'hold' });
  const cnt = counts({ before: 34, carryStart: '2026-09-22' });
  const held = S.heldCarry(c, cnt, TODAY, 20);
  ok('★ 부족분 366 − 반영 20 = 346 → 남은 자리 66 으로 자름(종전 순서면 46)', held === 66, String(held));
  const held2 = S.heldCarry(c, cnt, TODAY, 80);
  ok('반영분이 남은 자리보다 커도 빈자리를 0 으로 말하지 않는다(366 − 80 = 286 → 66)', held2 === 66, String(held2));
  const held3 = S.heldCarry(c, cnt, TODAY, 350);
  ok('부족분이 거의 다 반영됐으면 그만큼만(366 − 350 = 16)', held3 === 16, String(held3));
  console.log('  ✓ 보류 = min(부족분 − 반영분, 남은 자리)');
}

console.log('[2] 무작위 조합 — 이월 방식 · 주말 · 계획 · 일건수 ≥ 총 인원');
{
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const STRATS = ['next', 'spread', 'extend'];
  let cases = 0;
  for (let i = 0; i < 600; i++) {
    const rt = [5, 30, 100, 200, 750][rnd(5)];
    const dl = [1, 3, 10, 30, 100, 200][rnd(6)];
    const before = rnd(rt + 1);
    const todayDone = rnd(Math.max(1, Math.min(10, rt - before + 1)));
    const hold = rnd(5) === 0;
    const plans = {};
    if (rnd(3) === 0) for (let k = 0; k < 4; k++) plans[addDays(TODAY, rnd(20) - 8)] = rnd(dl * 3 + 1);
    const c = camp({ recruit_total: rt, daily_limit: dl, carry_strategy: STRATS[rnd(3)], carry_mode: hold ? 'hold' : 'auto',
      skip_weekends: rnd(2) === 0, start_date: addDays(TODAY, -rnd(15)) });
    const cnt = counts({ before, today: todayDone, carryStart: addDays(TODAY, -rnd(20)), plans: Object.keys(plans).length ? plans : null });
    const left = Math.max(0, rt - before - todayDone);
    const tag = JSON.stringify({ rt, dl, before, todayDone, s: c.carry_strategy, hold, sw: c.skip_weekends, plans });

    const pc = S.pendingCarry(c, cnt, TODAY, cnt.carry);
    ok('① 이월 ≤ 남은 자리', pc === null || pc <= left, tag + ' pc=' + pc);
    const held = S.heldCarry(c, cnt, TODAY, rnd(5));
    ok('① 보류 잔량 ≤ 남은 자리', held === null || held <= left, tag + ' held=' + held);

    const q = S.dailyQuota(c, before, cnt.carry, { today: TODAY, plans: cnt.plans });
    ok('② 오늘 정원 ≤ 총 − 어제까지 확정', q >= 0 && q <= rt - before, tag + ' q=' + q);

    const p = S.projectDailyQuotas(c, cnt, { now: NOW, maxDays: 400 });
    if (p) {
      const future = p.days.filter(d => d.date > TODAY).reduce((a, d) => a + d.quota, 0);
      ok('③ 하루도 음수 없음', p.days.every(d => d.quota >= 0), tag);
      ok('③ 앞날 합 + 확정 ≤ 총 인원', before + todayDone + future <= rt || future === 0, tag + ' future=' + future);
      ok('③ 남은 인원(remaining) ≤ 총 − 어제까지 확정', p.remaining === null || p.remaining <= rt - before, tag);
    }
    cases++;
  }
  console.log(`  ✓ ${cases}개 조합에서 ①②③ 모두 성립`);
}

console.log('[3] 총 인원 없음(무제한)은 자르지 않는다');
{
  const c = camp({ recruit_total: 0, daily_limit: 10, start_date: addDays(TODAY, -5) });
  const cnt = counts({ before: 0, carryStart: addDays(TODAY, -5) });
  const pc = S.pendingCarry(c, cnt, TODAY, cnt.carry);
  ok('무제한 공고의 이월은 종전 그대로(50)', pc === 50, String(pc));
  console.log('  ✓ 무제한 = 종전 동작');
}

console.log(`\ncarryTotalInvariant: ${passed} checks passed`);
