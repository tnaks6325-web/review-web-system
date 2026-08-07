/**
 * campaignCarryHold.test.js — 이월 보류·수동 반영(098) 회귀가드.
 *
 * 시안 = frontend/docs/이월보류_수동반영_와이어프레임.html (사용자 확정 3건:
 *   ① 기본 = 자동 반영(현행 불변) · 보류는 공고별 옵트인
 *   ② 반영 창구 = 카드 ⏸ 칩 원클릭 + [📅 인원] 팝업 둘 다
 *   ③ 홈 인라인 수정: 허용명단 리뷰어(스코프 토큰)도 설정 변경 가능 — 반영은 관리자 전용)
 *
 * ★★ 완화 금지 불변식
 *   ① carry_mode 미설정('auto'/NULL) = 기존 동작 100%(자동 이월 그대로).
 *   ② hold = 자동 이월 가산만 멈춤 — 총량 clamp·계획표(095)·조절일 규칙 불변(물량 소실 0).
 *   ③ 잔량 계산 불가(null)를 0으로 꾸미지 않는다(칩 미표시 · "조회 실패" 표기).
 *   ④ 반영(carryApply)은 adminOrMaster 전용 API — 스코프 토큰은 설정(auto/hold)까지만.
 *
 * 실행: node tests/campaignCarryHold.test.js
 *   (PGTEST_URL=postgres://… 지정 시 진짜 PG로 마이그레이션·기본값·시드까지 검증)
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

/* 스텁 pool — 서비스 require 전에 심는다(실 DB 무접촉) */
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
const d = (o) => new Date(Date.parse(today + 'T00:00:00Z') + o * 86400000).toISOString().slice(0, 10);

/* ═══ 1. dailyQuota — hold 게이트 ═══ */
console.log('\n[1] dailyQuota 보류 게이트');
const AUTO = { participation_mode: true, status: 'active', daily_limit: 40, recruit_total: 200, start_date: null, window_start: null, window_end: null };
const HOLD = { ...AUTO, carry_mode: 'hold' };
const carry = (since, over = {}) => ({ startDate: d(-2), today, submittedSince: since, ...over });

eq('★ 불변식 ①: auto(미설정) = 자동 이월 그대로(어제 5명 미달 → 45)',
  S.dailyQuota(AUTO, 75, carry(75)), 45);
eq('carry_mode=auto 명시도 동일(45)', S.dailyQuota({ ...AUTO, carry_mode: 'auto' }, 75, carry(75)), 45);
eq('★ hold: 자동 이월을 얹지 않는다(어제 5명 미달 → 40 그대로)',
  S.dailyQuota(HOLD, 75, carry(75)), 40);
eq('hold: 대량 미달도 40 그대로(상한 무관 — 애초에 안 얹는다)',
  S.dailyQuota(HOLD, 40, { startDate: d(-3), today, submittedSince: 40 }), 40);
eq('★ 불변식 ②: hold 여도 명시 조절일(095)은 그 값(오늘 조절 20 → 20)',
  S.dailyQuota(HOLD, 75, carry(75), { today, plans: { [today]: 20 } }), 20);
eq('★ 불변식 ②: hold 여도 총량 clamp(남은 자리 10 → 10)',
  S.dailyQuota(HOLD, 190, carry(110)), 10);
eq('모르는 carry_mode 값 = auto 취급(45)', S.dailyQuota({ ...AUTO, carry_mode: 'weird' }, 75, carry(75)), 45);

// 킬스위치 — require 시점 상수라 자식 프로세스로 검증(전건 자동 = 현행 복귀)
{
  const out = execFileSync(process.execPath, ['-e', `
    const S = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'campaignState.service.js'))});
    const HOLD = { daily_limit: 40, recruit_total: 200, carry_mode: 'hold' };
    console.log(S.dailyQuota(HOLD, 75, { startDate: '2026-08-04', today: '2026-08-06', submittedSince: 75 }));
  `], { env: { ...process.env, CAMPAIGN_CARRY_HOLD: '0' } }).toString().trim();
  eq('★ 킬스위치 CAMPAIGN_CARRY_HOLD=0 → hold 무시(자동 45)', out, '45');
}

/* ═══ 2. heldCarry — 잔량 순수함수 ═══ */
console.log('\n[2] heldCarry 잔량');
const CNT = (over = {}) => ({ hold: { startDate: d(-2), submittedSince: 75 }, plans: null, ...over });
eq('기본: 이틀 계획 80 − 확정 75 = 잔량 5', S.heldCarry(HOLD, CNT(), today), 5);
eq('★ 불변식 ③: auto 공고는 null(잔량 개념 없음)', S.heldCarry(AUTO, CNT(), today), null);
eq('★ 불변식 ③: 기준선 모름(hold null) = null(0으로 꾸미지 않는다)',
  S.heldCarry(HOLD, { hold: null, plans: null }, today), null);
eq('일건수 0 = null', S.heldCarry({ ...HOLD, daily_limit: 0 }, CNT(), today), null);
eq('시작 당일(경과 0일) = 0', S.heldCarry({ ...HOLD, start_date: today }, CNT(), today), 0);
eq('조절된 어제(20)가 계획에 반영: 40+20 − 확정 55 = 5',
  S.heldCarry(HOLD, CNT({ hold: { startDate: d(-2), submittedSince: 55 }, plans: { [d(-1)]: 20 } }), today), 5);
eq('오늘 조절값은 잔량(어제까지)에 미포함',
  S.heldCarry(HOLD, CNT({ plans: { [today]: 99 } }), today), 5);
eq('반영 누적 차감: 잔량 5 − 반영 3 = 2', S.heldCarry(HOLD, CNT(), today, 3), 2);
eq('과반영도 음수 없음(잔량 5 − 반영 10 = 0)', S.heldCarry(HOLD, CNT(), today, 10), 0);
eq('시작일이 기준선보다 늦으면 시작일부터(어제 시작 → 40−35=5)',
  S.heldCarry({ ...HOLD, start_date: d(-1) }, CNT({ hold: { startDate: d(-9), submittedSince: 35 } }), today), 5);

/* ═══ 3. 배선·정적 가드 ═══ */
console.log('\n[3] 서버 배선');
const st = readS('services/campaignState.service.js');
ok('판정 단일 출처 isCarryHold(게이트·잔량·목록이 공유)', /function isCarryHold\(c\)/.test(st)
  && /!isCarryHold\(c\) && CARRY_ENABLED/.test(st));
ok('기준선 2종은 한 쿼리(066 가드의 쿼리 순서 계약 유지)',
  /key IN \('campaign_carry_start', 'campaign_carry_hold_start'\)/.test(st));
ok('counts.hold 창 집계(FILTER $4)', /submitted_since_hold/.test(st) && /\$4 AND submitted_at < \$2/.test(st));

const mig = readM('098_campaign_carry_hold.sql');
const migSql = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');   // 주석 제외(주석의 'CHECK' 언급 오탐 방지)
ok('마이그레이션: 컬럼 기본 auto + DB CHECK 없음(087 규율)',
  /ADD COLUMN IF NOT EXISTS carry_mode TEXT DEFAULT 'auto'/.test(migSql) && !/CHECK/.test(migSql));
ok('보류 기준선 시드(ON CONFLICT DO NOTHING = 소급 차단·멱등)',
  /campaign_carry_hold_start/.test(mig) && /ON CONFLICT \(key\) DO NOTHING/.test(mig));

const cp = readS('services/campaignPlan.service.js');
ok('savePlans carryApply → carry_apply 이력(잔량 차감 원장)',
  /carry_not_hold/.test(cp) && /'carry_apply'/.test(cp) && /bad_carry/.test(cp));
ok('반영 합계 조회 fail-soft + 숫자 형태만 합산(손상 행 방어)',
  /fetchCarryAppliedSums/.test(cp) && /~ '\^\[0-9\]\+\$'/.test(cp));
ok('개요에 carryMode·carryHeld 동봉(null=조회 실패 — 0 위장 금지)',
  /carryMode: isCarryHold\(camp\)/.test(cp) && /carryHeld,/.test(cp));
ok('★ 병합 유실 복구: repairRecruitTotalFromRounds export 생존(미export = 경합 자가치유 무력화)',
  typeof require('../src/services/campaignPlan.service').repairRecruitTotalFromRounds === 'function');

const rt = readS('routes/campaign.routes.js');
ok('PUT: carry_mode COALESCE 센티널($40) + auto/hold 만 인정',
  /carry_mode = COALESCE\(\$40, carry_mode\)/.test(rt)
  && /\['auto', 'hold'\]\.includes\(carry_mode\) \? carry_mode : null/.test(rt));
ok('★ 확정 ③: 스코프 편집(홈 인라인)도 carry_mode 변경 가능 + 프리필 뷰 포함',
  /\['auto', 'hold'\]\.includes\(b\.carry_mode\)/.test(rt) && /carry_mode: row\.carry_mode \|\| 'auto'/.test(rt));
ok('admin/list 가 carryMode·carryHeld 를 내려준다(카드 ⏸ 칩 재료)',
  /carryMode: isCarryHold\(r\)/.test(rt) && /carryHeld: heldCarry\(r, cnt, _todayStr/.test(rt)
  && /fetchCarryAppliedSums\(pool, partIds\)/.test(rt));
const rtB = readS('routes/trackB.routes.js');
ok('trackB 오류코드 매핑(bad_carry·carry_not_hold = 400)', /bad_carry: 400, carry_not_hold: 400/.test(rtB));

/* ═══ 4. 프론트 배선 ═══ */
console.log('\n[4] 프론트 배선');
const modal = readF('js/recruit-modal.js');
const recruit = readF('js/index-recruit.js');
const cards = readF('js/campaign-cards.js');
const cdp = readF('js/campaign-daily-plan.js');
ok('수정 모달 세그먼트(rf_carry_mode hidden + 자동/보류 버튼)',
  /rf_carry_mode/.test(modal) && /rfCarrySet\('auto'\)/.test(modal) && /rfCarrySet\('hold'\)/.test(modal));
ok('★ 원칙 ⑤: 보류 선택 고지문(오늘 정원 복귀 + 물량 불소실)',
  /rf_carry_hold_note/.test(modal) && /보류로 이동/.test(modal) && /물량은 사라지지 않습니다/.test(modal));
ok('페이로드는 세그먼트 UI 있는 화면에서만 전송(미전송=유지)',
  /if \(document\.getElementById\("rf_carry_mode"\)\)/.test(recruit)
  && /payload\.carry_mode = document\.getElementById\("rf_carry_mode"\)\.value === "hold" \? "hold" : "auto"/.test(recruit));
ok('프리필·신규 초기화(silent — 사람이 고른 순간에만 고지 펼침)',
  /rfCarrySet\(c\.carry_mode === "hold" \? "hold" : "auto", \{ silent: true \}\)/.test(recruit)
  && /rfCarrySet\("auto", \{ silent: true \}\)/.test(recruit));
ok('홈 인라인 모달 세그먼트(cae_carry_mode) + 항상 명시 전송',
  /cae_carry_mode/.test(cards) && /_caeCarry\(data\.carry_mode === 'hold'/.test(cards)
  && /carry_mode: _caeV\('cae_carry_mode'\) === 'hold' \? 'hold' : 'auto'/.test(cards));
ok('★ 원칙 ⑦: 인라인 모달은 "반영은 관리자"를 문장으로(조용한 막다른 길 금지)',
  /반영은 관리자 화면/.test(cards));
ok('카드 ⏸ 칩 — carryHeld null 이면 미표시(0 위장 금지) + 모듈 게이트',
  /c\.carryMode === 'hold' && c\.carryHeld != null/.test(cards) && /pg-hold/.test(cards)
  && /CampaignDailyPlan\.quickApplyHeld\('\$\{_esc\(c\.id\)\}'\)/.test(cards));
ok('[📅 인원] 보류 블록(오늘/내일/분산 스테이징) + 조회 실패 문구',
  /_heldApply/.test(cdp) && /cdp-heldblk/.test(cdp) && /조회 실패/.test(cdp)
  && /잔량을 계산하지 못했습니다/.test(cdp));
ok('반영도 [확정 저장] 규율(carryApply 는 저장 본문에 동봉)',
  /carryApply: S\.carryStage/.test(cdp));
ok('원클릭 확인창 3택(오늘 반영/세부 선택/그대로 두기) + 즉시 저장 경로',
  /quickApplyHeld/.test(cdp) && /_quickDo/.test(cdp) && /그대로 두기/.test(cdp)
  && /carryApply: q\.held/.test(cdp));
ok('★ onclick 에 서버 문자열 보간 없음(XSS 규율 유지)', !/onclick="[^"]*\$\{/.test(cdp));

/* ═══ 5. savePlans carryApply 실행(스텁 pool) ═══ */
console.log('\n[5] savePlans carryApply 실행');
(async () => {
  const P = require('../src/services/campaignPlan.service');
  const schedMod = require('../src/services/campaignSchedule.service');
  schedMod.deriveSchedules = async () => new Map();
  schedMod.scheduleFor = () => null;
  const CAMP_ROW = (mode) => ({
    id: 'c1', title: '테스트', status: 'active', participation_mode: true,
    daily_limit: 40, recruit_total: 200, start_date: null, carry_mode: mode,
    linked_sheet_id: null, linked_tab_name: null, linked_tab_gid: null,
  });
  const baseStub = (mode) => ({
    'FROM recruit_campaigns WHERE id': [CAMP_ROW(mode)],
    'FROM campaign_daily_plans': [],
    'FROM campaign_rounds': [],
    'campaign_plan_events': [],
    'FROM campaign_applications': [{ today_submitted: 0, today_holds: 0, submitted: 0, holds: 0, n: 0 }],
    'app_settings': [{ key: 'campaign_carry_hold_start', value: d(-2) }],
  });

  // 5a. hold 공고: carryApply 가 carry_apply 이력으로 기록된다
  STUB = baseStub('hold');
  CALLS.length = 0;
  await P.savePlans('c1', { set: [{ date: today, count: 45 }], carryApply: 5, note: '이월 반영' }, 'tester');
  ok('carry_apply 이력 INSERT(amount=5)', CALLS.some(c =>
    c.sql.includes('campaign_plan_events') && c.sql.includes('carry_apply')
    && String((c.params || [])[2] || '').includes('"amount":5')));

  // 5b. auto 공고에 carryApply → carry_not_hold(반영할 보류분이 없다)
  STUB = baseStub('auto');
  await assert.rejects(P.savePlans('c1', { set: [{ date: today, count: 45 }], carryApply: 5 }, 't'),
    (e) => e.code === 'carry_not_hold');
  ok('★ auto 공고 반영 거부(carry_not_hold)', true);

  // 5c. 값 검증
  STUB = baseStub('hold');
  await assert.rejects(P.savePlans('c1', { set: [{ date: today, count: 45 }], carryApply: -1 }, 't'), (e) => e.code === 'bad_carry');
  ok('음수 반영량 거부(bad_carry)', true);
  await assert.rejects(P.savePlans('c1', { set: [{ date: today, count: 45 }], carryApply: 1.5 }, 't'), (e) => e.code === 'bad_carry');
  ok('소수 반영량 거부(bad_carry)', true);

  // 5d. carryApply 없으면 이력 0(기존 저장 경로 불변)
  STUB = baseStub('hold');
  CALLS.length = 0;
  await P.savePlans('c1', { set: [{ date: d(1), count: 50 }] }, 't');
  ok('carryApply 미전송 = carry_apply 이력 0(기존 경로 불변)',
    !CALLS.some(c => c.sql.includes("'carry_apply'")));

  // 5e. fetchCarryAppliedSums — 정상 합산 + fail-soft
  STUB = { 'carry_apply': [{ campaign_id: 'c1', s: '7' }] };
  eq('반영 합계 조회', (await P.fetchCarryAppliedSums(poolMod, ['c1'])).get('c1'), 7);
  STUB = { 'carry_apply': new Error('down') };
  ok('★ 합계 조회 실패 = 빈 Map(잔량 null 수렴 — fail-soft)',
    (await P.fetchCarryAppliedSums(poolMod, ['c1'])).size === 0);

  /* ═══ 6. 진짜 PG (PGTEST_URL 있을 때만) ═══ */
  if (process.env.PGTEST_URL) {
    console.log('\n[6] 진짜 PG 검증');
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS recruit_campaigns (id TEXT PRIMARY KEY, title TEXT)`);
      await c.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ)`);
      await c.query(mig);
      await c.query(mig);   // idempotent
      ok('마이그레이션 2회 적용 무사(idempotent)', true);
      await c.query(`INSERT INTO recruit_campaigns (id, title) VALUES ('h1','x') ON CONFLICT (id) DO NOTHING`);
      const { rows } = await c.query(`SELECT carry_mode FROM recruit_campaigns WHERE id='h1'`);
      eq('기존 행 기본값 auto(현행 불변)', rows[0].carry_mode, 'auto');
      await c.query(`UPDATE app_settings SET value='2020-01-01' WHERE key='campaign_carry_hold_start'`);
      await c.query(mig);
      const { rows: seed } = await c.query(`SELECT value FROM app_settings WHERE key='campaign_carry_hold_start'`);
      eq('★ 기준선 재실행에도 안 앞당겨짐(DO NOTHING)', seed[0].value, '2020-01-01');
      await c.query(`DELETE FROM recruit_campaigns WHERE id='h1'`);
    } finally { await c.end(); }
  } else {
    console.log('\n[6] PGTEST_URL 미지정 — 진짜 PG 검증 생략');
  }

  console.log(`\n✅ campaignCarryHold: ${n}개 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e.message); console.error(e.stack); process.exit(1); });
