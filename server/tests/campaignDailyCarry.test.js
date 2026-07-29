/**
 * campaignDailyCarry.test.js — 일 모집한도 미달분 자동 이월(066) 회귀가드.
 *
 * 관리자가 손으로 하던 것: 일건수 20인데 어제 15명 → 오늘 공고수정으로 25로 올림 →
 * 25가 차면 다음날 다시 20으로 되돌림. 이 계산을 시스템이 한다.
 *
 *   그날 정원 = min(daily_limit × 경과일수, daily_limit × 상한배수) − 기준선 이후 누적확정
 *
 * ★★ 완화 금지 불변식
 *   ① 절대 줄어들지 않는다 — 계산값이 daily_limit 미만이어도 daily_limit을 쓴다.
 *   ② 총 모집인원을 넘지 않는다 — 마지막 clamp 유지.
 *   ③ 소급 금지 — 기준선(app_settings.campaign_carry_start) 이전은 세지 않는다.
 *      없으면 배포 당일 과거 미달분이 한꺼번에 열려 하루에 수십 건이 쏟아진다.
 *   ④ 기준선을 모르면 이월하지 않는다(조회 실패 = 종전 동작).
 *
 * 실행: node tests/campaignDailyCarry.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const S = require('../src/services/campaignState.service');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const eq = (name, got, want) => ok(`${name} → ${got}`, got === want);

const CAMP = {
  participation_mode: true, status: 'active',
  daily_limit: 20, recruit_total: 100, start_date: null,
  window_start: null, window_end: null, close_buffer_min: 10,
};
/** 기준선 7/27, 오늘 7/29 = 3일차 */
const carry = (submittedSince, over = {}) =>
  ({ startDate: '2026-07-27', today: '2026-07-29', submittedSince, ...over });

/* ═══ 관리자가 손으로 하던 시나리오 그대로 ═══ */
eq('1·2일차 20씩 다 채움 → 오늘은 평소대로 20', S.dailyQuota(CAMP, 40, carry(40)), 20);
eq('★ 어제 5명 부족 → 오늘 25 (관리자가 손으로 25로 올리던 그 값)', S.dailyQuota(CAMP, 35, carry(35)), 25);
eq('이틀 연속 5명씩 부족 → 오늘 30', S.dailyQuota(CAMP, 30, carry(30)), 30);
eq('★ 오늘 25를 다 채우면 내일은 다시 20',
  S.dailyQuota(CAMP, 60, { startDate: '2026-07-27', today: '2026-07-30', submittedSince: 60 }), 20);

/* ═══ 불변식 ═══ */
eq('★★ ① 초과 달성해도 한도를 줄이지 않는다', S.dailyQuota(CAMP, 55, carry(55)), 20);
eq('★★ ② 총원 잔여를 넘지 않는다(총원 100·확정 90)', S.dailyQuota(CAMP, 90, carry(30)), 10);
eq('★★ ② 총원을 이미 채웠으면 0', S.dailyQuota(CAMP, 100, carry(30)), 0);
eq('상한(기본 2배) — 아무도 안 와도 40에서 멈춘다', S.dailyQuota(CAMP, 0, carry(0)), 40);
eq('상한은 오래 미달해도 유효(30일 경과)',
  S.dailyQuota(CAMP, 0, { startDate: '2026-07-01', today: '2026-07-30', submittedSince: 0 }), 40);
eq('상한 배수는 env로 조절 가능(코드 상수 확인)', S.CARRY_CAP_MULT >= 1, true);

/* ═══ 기준선(소급 방지) ═══ */
eq('★★ ③ 첫날(경과 1일)은 이월 없음 — 배포 당일 폭증 차단',
  S.dailyQuota(CAMP, 0, { startDate: '2026-07-29', today: '2026-07-29', submittedSince: 0 }), 20);
// 반년째 진행 중(전체 확정 500)이어도 이월은 기준선 이후 35건만 보고 계산한다.
// 전체 이력으로 계산하면 오늘 수백 건이 한꺼번에 열린다.
eq('기준선 이전에 시작한 캠페인도 기준선부터만 센다',
  S.dailyQuota({ ...CAMP, recruit_total: 1000, start_date: '2026-01-01' }, 500, carry(35)), 25);
eq('기준선 이후 시작한 캠페인은 자기 시작일부터',
  S.dailyQuota({ ...CAMP, start_date: '2026-07-29' }, 0, carry(0)), 20);
eq('★★ ④ 기준선을 모르면 이월하지 않는다(종전 동작)', S.dailyQuota(CAMP, 40, null), 20);
eq('이월 정보가 불완전해도 안전(startDate 없음)',
  S.dailyQuota(CAMP, 40, { today: '2026-07-29', submittedSince: 0 }), 20);
eq('daily_limit 0(무제한 일한도)이면 이월 계산 안 함',
  S.dailyQuota({ ...CAMP, daily_limit: 0 }, 0, carry(0)), 0);
eq('총원 무제한(recruit_total 0)에서도 이월·상한 동작',
  S.dailyQuota({ ...CAMP, recruit_total: 0 }, 0, carry(0)), 40);

/* ═══ 상태 payload — 관리자에게 이월 사실이 보이는가 ═══ */
{
  const now = new Date(Date.parse('2026-07-29T10:00:00+09:00'));
  const base = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 35, todaySubmitted: 0, submittedBeforeToday: 35 };
  const st = S.computeCampaignState(CAMP, { ...base, carry: { startDate: '2026-07-27', submittedSince: 35 } }, now);
  eq('상태 payload의 dailyQuota에 이월이 반영', st.dailyQuota, 25);
  eq('★ carryAdded로 "얼마나 더 열렸는지"를 알린다(설정값과 달라 보이는 이유)', st.carryAdded, 5);

  const plain = S.computeCampaignState(CAMP, base, now);
  eq('carry 미제공이면 종전 그대로', plain.dailyQuota, 20);
  eq('carryAdded 0', plain.carryAdded, 0);
}

/* ═══ 시트 일정 캠페인은 이 경로를 타지 않는다(063이 이미 이월) ═══ */
{
  const now = new Date(Date.parse('2026-07-29T10:00:00+09:00'));
  const sch = { ok: true, dates: [{ date: '2026-07-28', slots: 3 }, { date: '2026-07-29', slots: 3 }],
                byDate: { '2026-07-28': 3, '2026-07-29': 3 }, firstDate: '2026-07-28', lastDate: '2026-07-29',
                totalSlots: 6, source: 'sheet' };
  const st = S.computeCampaignState(CAMP,
    { activeHolds: 0, todayActiveHolds: 0, submittedAll: 1, todaySubmitted: 0, submittedBeforeToday: 1,
      carry: { startDate: '2026-07-01', submittedSince: 1 } }, now, sch);
  eq('★ 시트 일정이 있으면 시트가 정원을 정한다(이월 이중적용 없음)', st.dailyQuota, 5);
}

/* ═══ 카운트 조회 — 기준선과 그 이후 확정 수를 함께 싣는가(스텁 pool) ═══ */
(async () => {
  const q = [];
  const stub = {
    query: async (sql, params) => {
      q.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/app_settings/.test(sql)) return { rows: [{ value: '2026-07-27' }] };
      return { rows: [{ campaign_id: 'c1', active_holds: 1, today_active_holds: 1, submitted_all: 40,
                        today_submitted: 5, submitted_before_today: 35, submitted_since_carry: 35 }] };
    },
  };
  S.__resetCarryCacheForTest();
  const m = await S.fetchCampaignCounts(stub, ['c1'], new Date(Date.parse('2026-07-29T10:00:00+09:00')));
  const c1 = m.get('c1');
  ok('기준선을 app_settings에서 읽는다', /campaign_carry_start/.test(q[0].sql));
  ok('카운트에 이월 정보가 함께 실린다',
    c1.carry && c1.carry.startDate === '2026-07-27' && c1.carry.submittedSince === 35);
  ok('★ 기준선 이후 ~ 오늘 이전 확정만 센다(쿼리 조건)',
    /submitted_at >= \$3 AND submitted_at < \$2\) *AS submitted_since_carry/.test(q[1].sql));
  ok('기존 카운트 계약은 그대로(호출부 무영향)',
    c1.activeHolds === 1 && c1.todaySubmitted === 5 && c1.submittedBeforeToday === 35);

  // 기준선 조회 실패 → 이월 미적용(fail-safe)
  S.__resetCarryCacheForTest();
  const m2 = await S.fetchCampaignCounts({
    query: async (sql) => {
      if (/app_settings/.test(sql)) throw new Error('DB down');
      return { rows: [] };
    },
  }, ['c1'], new Date());
  ok('★★ 기준선 조회 실패 = 이월 미적용(모르면 안 늘린다)', m2.get('c1').carry === null);

  /* ═══ 배선 ═══ */
  const st = readS('services/campaignState.service.js');
  const rt = readS('routes/campaign.routes.js');
  const cards = readF('js/campaign-cards.js');

  ok('마이그레이션 066(기준선 시드, 멱등)',
    fs.existsSync(path.join(__dirname, '..', 'migrations', '066_campaign_daily_carry.sql'))
    && /ON CONFLICT \(key\) DO NOTHING/.test(
      fs.readFileSync(path.join(__dirname, '..', 'migrations', '066_campaign_daily_carry.sql'), 'utf8')));
  ok('env 킬스위치(CAMPAIGN_DAILY_CARRY=0)', /process\.env\.CAMPAIGN_DAILY_CARRY !== '0'/.test(st));
  ok('상한 env(CAMPAIGN_DAILY_CARRY_CAP)', /CAMPAIGN_DAILY_CARRY_CAP \|\| 2/.test(st));
  ok('★ 불변식 ① 코드에 명시(축소 금지)', /if \(q < dl\) q = dl;/.test(st));
  ok('★ 불변식 ② 총원 clamp 유지', /Math\.min\(q, rt - before\)/.test(st));
  ok('관리자 목록이 carryAdded 를 내려준다', /carryAdded: st\.carryAdded \|\| 0/.test(rt));
  ok('관리자 카드가 "+N 이월"을 표시(설정값과 달라 보이는 이유 설명)',
    /pg-carry/.test(cards) && /\+\$\{carry\} 이월/.test(cards)
    && /오늘 다 채우면 내일은 원래 한도로 돌아갑니다/.test(cards));

  console.log(`\n✅ campaignDailyCarry: ${n}개 통과`);
})();
