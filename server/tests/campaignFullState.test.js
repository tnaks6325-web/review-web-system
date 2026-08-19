/**
 * campaignFullState.test.js — "다 모집했는데 내일 다시 오픈" 회귀가드 (7/31 올리브영 건).
 *
 * 관측된 현상: 100명 모집 캠페인이 오늘 20/20을 채운 뒤 "8/1 다시 오픈"으로 표시.
 * 원인 두 가지를 각각 고정한다.
 *   ① 총원 충족 판정이 일일 마감보다 **뒤에** 있어, 총원이 차면 quota가 0이 되고
 *      `todayCount(0) >= quota(0)` 이 먼저 참이 되어 매일 daily_done 으로 보였다.
 *   ② 하루에 끝나는 캠페인(날짜 1종)은 시트 일정이 인식되지 않아 마감일을 시스템이 모른다.
 *      → 자동 종료로 바꾸면 "시트가 덜 준비된 캠페인"을 조기 종료시키는 위험이 있어
 *        **관제 진단으로만** 드러낸다(상태 계산 무변경).
 *
 * ★ 두 상태(soft_full·daily_done) 모두 apply 차단이라 **참여 동작은 순서와 무관**하다.
 *
 * 실행: node tests/campaignFullState.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

// ★ 모집 정원 기준의 기본값은 **시스템표**(2026-08-07 사용자 확정)라 시트 일정 엔진 자체를
//   검증하는 이 파일은 그 엔진을 켜고 돌린다(env 는 require 시점에 읽힌다 — 위에 둘 것).
process.env.CAMPAIGN_SHEET_SCHEDULE = '1';
const S = require('../src/services/campaignState.service');
const SCH = require('../src/services/campaignSchedule.service');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const eq = (name, got, want) => ok(`${name} → ${got}`, got === want);

// 실제 사고 캠페인 형태: 자율주문(시간창 없음) · 일 20 · 총 100
const C = { participation_mode: true, status: 'active', daily_limit: 20, recruit_total: 100,
            start_date: null, window_start: null, window_end: null, close_buffer_min: 10 };
const cnt = (o) => ({ activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0, ...o });
const at = (iso) => new Date(Date.parse(iso));
const st = (counts, when) => S.computeCampaignState(C, counts, at(when)).state;

/* ═══ ① 상태 판정 순서 ═══ */
eq('★★ 총원 100/100 → soft_full (내일 다시 오픈으로 보이지 않는다)',
  st(cnt({ submittedAll: 100, submittedBeforeToday: 100 }), '2026-08-01T10:00:00+09:00'), 'soft_full');
eq('총원 + 유효홀드 합산도 충족으로 본다(99확정 + 홀드1)',
  st(cnt({ submittedAll: 99, submittedBeforeToday: 99, activeHolds: 1 }), '2026-08-01T10:00:00+09:00'), 'soft_full');
eq('★ 1명 남으면 실제로 열린다(사고 당시 8/1 상태)',
  st(cnt({ submittedAll: 99, submittedBeforeToday: 99 }), '2026-08-01T10:00:00+09:00'), 'open');
eq('오늘 한도만 찬 경우는 종전대로 daily_done',
  st(cnt({ submittedAll: 99, submittedBeforeToday: 79, todaySubmitted: 20 }), '2026-07-31T22:00:00+09:00'), 'daily_done');
eq('총원 무제한(0)이면 총원 판정이 끼어들지 않는다',
  S.computeCampaignState({ ...C, recruit_total: 0 }, cnt({ submittedAll: 999 }), at('2026-08-01T10:00:00+09:00')).state, 'open');

ok('★★ 참여 차단은 두 상태 모두 동일 — 순서 변경이 참여 동작을 바꾸지 않는다',
  S.APPLY_BLOCK_REASON.soft_full === 'soft_full' && S.APPLY_BLOCK_REASON.daily_done === 'daily_done');
ok('총원 판정이 일일 마감보다 앞에 있다(순서 고정)',
  /usedAll >= rt\) return \{ \.\.\.payload, state: 'soft_full' \};[\s\S]{0,220}if \(todayCount >= quota\)/.test(
    readS('services/campaignState.service.js')));

/* 시트 일정 캠페인도 같은 규율 — totalSlots 충족 시 soft_full */
{
  const sch = { ok: true, dates: [{ date: '2026-07-30', slots: 3 }, { date: '2026-07-31', slots: 3 }],
                byDate: { '2026-07-30': 3, '2026-07-31': 3 }, firstDate: '2026-07-30', lastDate: '2026-07-31',
                totalSlots: 6, source: 'sheet' };
  eq('시트 일정 캠페인도 총건수 충족 시 soft_full',
    S.computeCampaignState(C, cnt({ submittedAll: 6, submittedBeforeToday: 6 }), at('2026-07-31T10:00:00+09:00'), sch).state,
    'soft_full');
}

/* ═══ ② 하루 완결 캠페인 — 상태 계산은 그대로(조기 종료 위험 회피) ═══ */
ok('★★ 날짜 1종은 여전히 일정 미적용 — 자동 종료로 바꾸지 않았다',
  SCH.summarizeDates(['2026-07-31', '2026-07-31', '2026-07-31'], 3) === null);
ok('날짜 2종부터 적용(기존 계약 불변)',
  !!SCH.summarizeDates(['2026-07-30', '2026-07-31'], 2));
ok('최소 날짜 종수 상수는 2 유지', SCH.MIN_DISTINCT_DATES === 2);

/* ═══ ②③ 관제 진단 — 게이트 없이 사실을 보여준다 ═══ */
(async () => {
  const mkDb = (headerCells, dateCol) => ({
    query: async (sql, params) => {
      if (/row_index <= /.test(sql)) return { rows: [{ row_index: 1, cells: headerCells }] };
      if (/cells->>\$3/.test(sql)) return { rows: dateCol.map(v => ({ v })) };
      return { rows: [] };
    },
  });
  const HDR = ['번호', '구매일자', '수취인', '연락처'];

  const single = await SCH.describeTabDates(mkDb(HDR, Array(100).fill('7 / 31 (금)')), 'S1', '123',
    at('2026-07-31T10:00:00+09:00'));
  ok('★ 하루 완결 시트를 "미적용 + single_date"로 설명한다',
    single.ok && single.applied === false && single.reason === 'single_date');
  eq('그 날짜와 행 수를 그대로 보여준다', single.dates[0].rows, 100);
  eq('날짜 종수', single.distinctDates, 1);

  const multi = await SCH.describeTabDates(
    mkDb(HDR, ['7 / 30 (목)', '7 / 31 (금)', '7 / 31 (금)']), 'S1', '123', at('2026-07-31T10:00:00+09:00'));
  ok('날짜 2종은 적용으로 보고', multi.applied === true && multi.reason === 'applied');
  eq('마지막 날짜', multi.lastDate, '2026-07-31');

  const noMirror = await SCH.describeTabDates({ query: async () => ({ rows: [] }) }, 'S1', '123');
  eq('미러 전이면 사유를 알려준다', noMirror.reason, 'no_mirror');
  const noCol = await SCH.describeTabDates(mkDb(['번호', '이름'], []), 'S1', '123');
  eq('날짜 컬럼이 없으면 사유를 알려준다', noCol.reason, 'no_date_column');
  const err = await SCH.describeTabDates({ query: async () => { throw new Error('boom'); } }, 'S1', '123');
  ok('★ 조회 실패해도 예외를 던지지 않는다(관제가 깨지지 않음)', err.ok === false && err.reason === 'error');
  eq('탭 정보 없으면 no_tab', (await SCH.describeTabDates(null, '', '')).reason, 'no_tab');

  /* ═══ 배선 ═══ */
  const rt = readS('routes/campaign.routes.js');
  const rec = readF('js/index-recruit.js');

  ok('관제 응답에 시트 대조(sheetInfo)가 실린다',
    /sheetInfo = \{/.test(rt) && /options, sheetInfo \}\)/.test(rt));
  ok('로스터는 인덱스 행 수로 센다(시트 재읽기 없음 = 쿼터 0)',
    /SELECT COUNT\(\*\)::int AS n FROM review_index WHERE sheet_id = \$1 AND tab_name = \$2/.test(rt));
  ok('★ 시트 대조 실패가 관제를 깨지 않는다(fail-soft)',
    /catch \(siErr\) \{ logger\.warn\('\[campaign\/admin\/applications\] 시트 대조 실패/.test(rt));
  ok('★ 진단은 읽기 전용 — 상태를 바꾸는 코드가 없다',
    !/sheetInfo[\s\S]{0,400}UPDATE recruit_campaigns/.test(rt));
  // ⚠ 무시트 어휘 정리(2026-08-19)로 이 문구들이 `_srcWords` 템플릿이 됐다 — 검사 의미는 불변
  //   ("차이를 숫자로 말한다" · "자리는 있는데 확정이 아니다를 설명한다"). 어휘 자체는
  //   sheetVocabulary 가드가 실행으로 고정한다.
  ok('관제 화면이 로스터 차이를 표시한다',
    /function _campSheetInfo/.test(rec) && /차이 \$\{diff\}건/.test(rec)
    && /\$\{w\.src\}에는 자리가 있는데 확정으로 안 잡힌 건입니다/.test(rec));
  ok('관제 화면이 "시트 일정 미적용" 사유를 설명한다',
    /single_date:/.test(rec) && /\$\{w\.sched\}이 적용되지 않습니다/.test(rec)
    && /no_mirror:/.test(rec));

  /* ═══ 차이가 난 **행**을 짚어준다 ═══ */
  ok('차이가 있을 때만 불일치 행을 조회한다(평상시 쿼리 0)',
    /if \(rosterRows > confirmed\) \{[\s\S]{0,1200}NOT EXISTS/.test(rt));
  /* ⚠ 2026-08-19: 대조 키가 phone8 하나 → **세 키**로 넓어졌다(검사 의미 = 사용자 확정 규칙).
     되돌리면 위프 800건에서 실측된 오표시(정상 확정 17건이 "미확정"으로, 같은 건이 반대편에서
     "확정인데 줄 없음"으로 이중 계수)가 그대로 재현된다. */
  ok('대조 키 ㉮ 명의 phone8',
    /s\.phone8 <> '' AND s\.phone8 = ri\.phone8/.test(rt));
  ok('★ 대조 키 ㉯ 소유자 owner_phone8 — 타계정 건의 작업표 연락처는 소유자 번호일 수 있다',
    /s\.owner_phone8 = ri\.phone8/.test(rt));
  ok('★★ 대조 키 ㉰ 주문 링크 — 연락처 오타·수취인 번호 기입은 번호로 영원히 못 짝짓는다',
    /JOIN sub s ON s\.order_submission_id = cp\.order_submission_id/.test(rt)
    && /cp\.seq = ri\.row_index AND cp\.deleted_at IS NULL/.test(rt));
  ok('★ 종류별 건수를 서버가 세어 내려준다(목록은 30건 상한이라 화면에서 못 센다)',
    /unmatchedCounts = \{ total, hold, orderOnly, neither/.test(rt) && /unmatchedCounts,/.test(rt));
  ok('★ 홀드 이력·주문 유무를 줄마다 실어 보낸다',
    /hasHold: r\.has_hold === true/.test(rt) && /hasOrder: r\.has_order === true/.test(rt));
  ok('★ 조치 대상이 목록 앞에 온다(30건 상한에 밀려 안 보이면 안 된다)',
    /ORDER BY has_hold DESC, has_order ASC, row/.test(rt));
  ok('행 번호·이름과 함께 돌려준다(어느 줄인지 짚기)',
    /ri\.row_index AS row, ri\.reviewer_name AS name/.test(rt) && /LIMIT 30/.test(rt));
  ok('★ 연락처 뒤 4자리만 내려준다(관제 화면 PII 최소화)',
    /phone4: String\(r\.phone8 \|\| ''\)\.replace\(\/\\D\/g, ''\)\.slice\(-4\)/.test(rt)
    && !/phone8: r\.phone8/.test(rt));
  ok('관제가 불일치 행을 나열한다',
    /function _campUnmatchedRows/.test(rec) && /확정으로 안 잡힌 \$\{w\.rows\}/.test(rec));
  /* ★★ 종류별로 할 일이 다르다 — 섞어서 "[수동확정]하세요"로 안내하면 담당자가
     만료·취소 목록에 없는 건을 찾게 된다(위프 800건 실측: 196건 중 163건이 그랬다). */
  ok('★ 공고 미경유 제출은 "조치 불필요"라고 말한다',
    /조치 불필요/.test(rec) && /만료·취소 목록에는 없습니다/.test(rec));
  ok('★ 홀드 이력이 있는 줄에만 [수동확정]을 안내한다',
    /참여 기록은 있는데 확정이 아닙니다[\s\S]{0,120}\[수동확정\]/.test(rec));
  ok('★ 머리줄 "차이"와 목록 건수가 다른 이유를 말한다(말없이 다르면 오해)',
    /주문 기록·소유자 번호로 확정과 짝지어진/.test(rec) && /diff > c\.total/.test(rec));
  ok('★ 건수는 서버가 준 값만 쓴다(구버전 백엔드면 요약 줄 자체를 안 그린다)',
    /counts && typeof counts\.total === "number" \? counts : null/.test(rec)
    && !/list\.length[\s\S]{0,40}건<\/b>/.test(rec));
  ok('★ "정원은 위치가 아니라 숫자"임을 코드에 남긴다(오해 방지)',
    /캠페인 정원은 '위치'가 아니라 '숫자'/.test(rec));
  ok('연락처 없는 행은 대조 불가임을 안내(영구 오탐 오해 방지)',
    /연락처가 비어 있는 행은 대조가 불가능해/.test(rec));

  console.log(`\n✅ campaignFullState: ${n}개 통과`);
})();
