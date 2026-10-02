/**
 * campaignOptionDailyCap.test.js — 상품(선택지)별 정원·일건수 잔량 회귀가드 (사용자 확정 2026-10-02)
 * 실행: node tests/campaignOptionDailyCap.test.js
 *
 * 규칙: 정원 5 · 일건수 3 이면 첫날 3명 → 둘째 날은 잔량 2명까지만 받고 정원에서 멈춘다.
 *  ① 참여 판정(status/selectable)은 정원 소진을 먼저 본다(정원 초과 금지)
 *  ② 화면에 쓰는 "오늘 남은 자리"는 남은 정원보다 크게 말하지 않는다
 */
const assert = require('assert');
const { computeOptionView } = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

const opt = { opt_key: 'A', recruit_total: 5, daily_limit: 3, status: 'active' };
const view = (submitted, todaySubmitted, holds = 0, todayHolds = 0) =>
  computeOptionView(opt, { submitted, todaySubmitted, activeHolds: holds, todayActiveHolds: todayHolds }, { state: 'open' });

// 첫날
let v = view(0, 0);
ok('첫날 시작: 오늘 3자리 · 남은 5', v.todayRemaining === 3 && v.remaining === 5 && v.selectable);
v = view(3, 3);
ok('첫날 3명 뒤: 오늘 마감(내일 가능)', v.status === 'today_done' && !v.selectable && v.todayRemaining === 0);

// 둘째 날(오늘 참여 0으로 초기화, 누적 3)
v = view(3, 0);
ok('둘째 날 시작: 오늘 남은 자리 = 잔량 2(일건수 3 아님)', v.todayRemaining === 2 && v.remaining === 2 && v.selectable);
v = view(4, 1);
ok('둘째 날 1명 뒤: 오늘 1 · 남은 1', v.todayRemaining === 1 && v.remaining === 1 && v.selectable);
v = view(5, 2);
ok('둘째 날 2명 뒤: 정원 소진(soldout) — 셋째 사람 차단', v.status === 'soldout' && !v.selectable && v.todayRemaining === 0);

// 진행 중(결제 중) 자리도 정원을 차지한다
v = view(3, 0, 2, 2);
ok('둘째 날 결제 중 2명: 정원 소진으로 막힘', v.status === 'soldout' && !v.selectable);

// 무제한 정원이면 일건수 그대로
v = computeOptionView({ opt_key: 'B', recruit_total: 0, daily_limit: 3, status: 'active' }, { submitted: 10, todaySubmitted: 1 }, { state: 'open' });
ok('정원 무제한: 오늘 남은 자리 = 일건수 기준 2', v.remaining === null && v.todayRemaining === 2);
// 일건수 없음이면 null 유지(오늘 제한 표기 안 함)
v = computeOptionView({ opt_key: 'C', recruit_total: 5, daily_limit: 0, status: 'active' }, { submitted: 3 }, { state: 'open' });
ok('일건수 없음: 오늘 표기 없음(null)', v.todayRemaining === null && v.remaining === 2);

console.log(`\ncampaignOptionDailyCap: ${passed} passed`);
