/**
 * campaignReopenWeekend.test.js — 카드 "다시 오픈" 날짜가 실제로 열리는 날을 가리키는지 고정.
 *
 * 신고(2026-08-21): 주말 제외 공고가 금요일에 정원을 채우면 썸네일이 `8/22(토) 다시 오픈`이라
 *   말하고, 정작 토요일에는 apply 가 막혀 문구가 `주말 미게시 · 월요일 재개`로 뒤집혔다.
 *   원인 = `_reopenIso()` 가 시트 일정이 없으면 **무조건 내일**을 돌려줬다(주말·0명 조절 미참조).
 *
 * ★★ 이 가드가 고정하는 불변식
 *   ① "다시 오픈" 날짜는 **apply 게이트와 같은 판정**(isWeekendClosedOn)으로 주말을 건너뛴다.
 *   ② 0명 조절(095)한 날도 건너뛴다 — 그날은 열리지 않는다는 뜻이므로.
 *   ③ 못 찾으면 **첫 후보(종전 동작)** 로 접는다 — 카운트다운을 빈 값으로 두지 않는다.
 *   ④ "무조건 내일"로 되돌리는 헬퍼(kstTomorrowStr)는 되살리지 않는다.
 */
const assert = require('assert');
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

const state = require('../src/services/campaignState.service');
const { weekendPublicationState, isWeekendClosedOn } = require('../src/services/campaignWeekend.service');
const { nextOpenDate, nextOpenAt, openMinutesFor, computeCampaignState } = state;

const FRI = '2026-08-21';   // 금
const SAT = '2026-08-22';
const SUN = '2026-08-23';
const MON = '2026-08-24';

/* ── [1] 주말 판정 단일 출처 ───────────────────────────────── */
console.log('\n[1] 주말 판정 단일 출처');
{
  const src = read('src/services/campaignState.service.js');
  ok('★★ 상태엔진이 게시 차단과 같은 함수를 쓴다(isWeekendClosedOn require — 판정 사본 0)',
    /require\('\.\/campaignWeekend\.service'\)/.test(src) && /isWeekendClosedOn\(c, d\)/.test(src));
  ok('★ "무조건 내일" 헬퍼(kstTomorrowStr) 부재 — 되살리면 신고 건이 그대로 재현된다',
    !/kstTomorrowStr/.test(src));
  ok('주말 판정과 게시 차단이 같은 날짜에 대해 어긋나지 않는다(토요일)',
    isWeekendClosedOn({ skip_weekends: true }, SAT) === true
    && weekendPublicationState({ skip_weekends: true }, new Date('2026-08-21T15:00:00.000Z')).blocked === true);
  ok('주말 포함 공고는 어떤 날짜도 주말로 닫지 않는다',
    [SAT, SUN, MON].every(d => isWeekendClosedOn({ skip_weekends: false }, d) === false));
  ok('★ 형식 밖 날짜는 막지 않는다(모른다고 날짜를 건너뛰지 않는다)',
    isWeekendClosedOn({ skip_weekends: true }, '') === false
    && isWeekendClosedOn({ skip_weekends: true }, '2026-08') === false);
}

/* ── [2] nextOpenDate 순수함수 ─────────────────────────────── */
console.log('\n[2] 다음 오픈일 판정');
{
  const incl = { skip_weekends: false };
  const excl = { skip_weekends: true };
  ok('주말 포함 · 금요일 → 토요일(종전 동작 불변)', nextOpenDate(incl, FRI, null, null) === SAT);
  ok('★★ 주말 제외 · 금요일 → 월요일(신고 건)', nextOpenDate(excl, FRI, null, null) === MON);
  ok('주말 제외 · 토요일 → 월요일', nextOpenDate(excl, SAT, null, null) === MON);
  ok('주말 제외 · 일요일 → 월요일', nextOpenDate(excl, SUN, null, null) === MON);
  ok('★ 0명 조절한 날은 건너뛴다(095 — 그날은 안 연다)',
    nextOpenDate(incl, FRI, null, { [SAT]: 0 }) === SUN);
  ok('★ 1명 이상 조절은 건너뛰지 않는다(완화 금지 — 사람이 정한 인원)',
    nextOpenDate(incl, FRI, null, { [SAT]: 1 }) === SAT);
  ok('주말·0명 조절이 겹쳐도 첫 열리는 날을 찾는다',
    nextOpenDate(excl, FRI, null, { [MON]: 0 }) === '2026-08-25');
  ok('★★ 앞으로 전부 막혀 있으면 첫 후보로 접는다(빈 값 금지)',
    (() => {
      const plans = {};
      for (let i = 1; i <= 90; i++) plans[state.addIsoDays(FRI, i)] = 0;
      return nextOpenDate(incl, FRI, null, plans) === SAT;
    })());
  ok('★ 시트 일정이 있으면 진행일만 훑고, 그중 주말도 건너뛴다',
    nextOpenDate(excl, FRI, { dates: [{ date: SAT, slots: 3 }, { date: MON, slots: 3 }] }, null) === MON);
  ok('시트 일정에 다음 진행일이 없으면 null(종전 nextWorkDate 계약)',
    nextOpenDate(excl, FRI, { dates: [{ date: FRI, slots: 3 }] }, null) === null);
}

/* ── [3] 오픈 시각 단일 출처 ───────────────────────────────── */
console.log('\n[3] 오픈 시각');
{
  ok('자율주문(시간창 없음) = 그날 KST 자정', openMinutesFor({}) === 0);
  ok('시간창 있으면 window_start', openMinutesFor({ window_start: '09:00', window_end: '18:00' }) === 540);
  const r = nextOpenAt({ skip_weekends: true, window_start: '09:00', window_end: '18:00' },
    { plans: null }, new Date('2026-08-21T05:00:00.000Z'), null);
  ok('★ nextOpenAt = { date, iso } — 월요일 09:00 KST',
    r && r.date === MON && r.iso === '2026-08-24T00:00:00.000Z');
}

/* ── [4] 상태엔진 실행 ─────────────────────────────────────── */
console.log('\n[4] 상태엔진 실행(금일 마감 카드)');
{
  const base = {
    id: 'c1', status: 'active', participation_mode: true,
    daily_limit: 5, recruit_total: 100, window_start: '09:00', window_end: '18:00',
  };
  const counts = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 5, todaySubmitted: 5, submittedBeforeToday: 0 };
  const now = new Date('2026-08-21T05:00:00.000Z');   // 금 14:00 KST

  const incl = computeCampaignState({ ...base, skip_weekends: false }, counts, now, null);
  ok('주말 포함 공고는 종전대로 토요일 오픈을 가리킨다',
    incl.state === 'daily_done' && incl.reopensAt === '2026-08-22T00:00:00.000Z');

  const excl = computeCampaignState({ ...base, skip_weekends: true }, counts, now, null);
  ok('★★ 주말 제외 공고는 월요일 오픈을 가리킨다(신고 건 수정)',
    excl.state === 'daily_done' && excl.reopensAt === '2026-08-24T00:00:00.000Z');

  const allDay = computeCampaignState({ ...base, skip_weekends: true, window_start: null, window_end: null },
    counts, now, null);
  ok('★ 자율주문 공고도 월요일 KST 자정을 가리킨다',
    allDay.reopensAt === '2026-08-23T15:00:00.000Z');

  const planned = computeCampaignState({ ...base, skip_weekends: false }, { ...counts, plans: { [SAT]: 0 } }, now, null);
  ok('★ 내일이 0명 조절이면 그 다음 날을 가리킨다',
    planned.reopensAt === '2026-08-23T00:00:00.000Z');
}

/* ── [5] 카드 투영 배선 ────────────────────────────────────── */
console.log('\n[5] 카드 투영(라우트)');
{
  const route = read('src/routes/campaign.routes.js');
  ok('★ 주말 재개일은 apply 게이트와 같은 판정(nextOpenAt)으로 계산한다',
    /function _weekendResume/.test(route) && /nextOpenAt\(row, counts, now, schedule\)/.test(route));
  ok('공개 뷰 두 분기 모두 resumesAt 을 싣는다(레거시·참여형)',
    (route.match(/resumesAt: resume \? resume\.iso : null/g) || []).length >= 2);
  ok('★ 계산 실패는 정책값(다음 월요일)으로 접는다 — 빈 값 금지',
    (route.match(/resume \? resume\.date : weekend\.resumesOn/g) || []).length >= 2);
  ok('★★ 관리자 목록도 주말 미게시를 그대로 보여준다(종전엔 공개 목록에만 적용)',
    /state: _weekend\.blocked \? 'weekend_unpublished' : st\.state/.test(route)
    && /resumesAt: _resume \? _resume\.iso : null/.test(route));
}

/* ── [6] 카드 렌더 실행 ────────────────────────────────────── */
console.log('\n[6] 카드 렌더 실행');
{
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
    getBoundingClientRect: () => ({}), querySelector: () => null, querySelectorAll: () => [],
    insertAdjacentHTML() {}, remove() {}, contains: () => true, innerHTML: '', textContent: '' });
  const win = { location: { hostname: 'x' }, addEventListener() {},
    sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null }, confirm: () => true };
  const doc = { head: el(), body: el(), createElement: () => el(), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), API_BASE_URL: '' };
  sb.globalThis = sb; win.document = doc;
  vm.createContext(sb);
  vm.runInContext(read('../frontend/js/campaign-cards.js'), sb, { filename: 'campaign-cards.js' });
  const CC = sb.window.CampCards;
  CC.setServerNow(new Date('2026-08-21T05:00:00.000Z').toISOString());

  const base = { id: 'c1', title: 'T', participation_mode: true, status: 'active',
    dailyQuota: 5, todayCount: 5 };

  const daily = CC.cardHtml({ ...base, state: 'daily_done', reopensAt: '2026-08-24T00:00:00.000Z' });
  ok('★★ 금일마감 썸네일이 서버가 준 재오픈일을 그대로 센다',
    /data-camp-countdown="2026-08-24T00:00:00.000Z"/.test(daily) && /다시 오픈/.test(daily));
  ok('★ 푸터도 "내일"을 박지 않고 실제 재오픈일을 말한다',
    /8\/24\(월\)/.test(daily) && !/내일/.test(daily));
  ok('★ 썸네일 문구에 "오픈"이 두 번 찍히지 않는다(_fmtOpenWhen 조각 사용)',
    /8\/24\(월\) 다시 오픈/.test(daily) && !/오픈 다시 오픈/.test(daily));

  const wk = CC.cardHtml({ ...base, state: 'weekend_unpublished', stateReason: 'weekend_unpublished',
    stateMessage: '주말 미게시 · 월요일 재개', resumesOn: MON, resumesAt: '2026-08-24T00:00:00.000Z' });
  ok('★★ 주말 미게시 카드에도 썸네일 카운트다운이 있다(종전엔 오버레이가 통째로 사라졌다)',
    /주말 미게시/.test(wk) && /data-camp-countdown="2026-08-24T00:00:00.000Z"/.test(wk) && /8\/24\(월\) 재개/.test(wk));

  const wkNoIso = CC.cardHtml({ ...base, state: 'weekend_unpublished', stateReason: 'weekend_unpublished',
    stateMessage: '주말 미게시 · 월요일 재개', resumesOn: MON });
  ok('★ 재개 시각을 못 받으면(구버전 백엔드) 오버레이 없이 종전 문구만 — 0으로 꾸미지 않는다',
    !/data-camp-countdown/.test(wkNoIso) && /주말 미게시/.test(wkNoIso));

  const order = CC.sortByAvailability([
    { id: 'a', state: 'weekend_unpublished' }, { id: 'b', state: 'open' },
  ]).map(x => x.id).join(',');
  /* ★ 등급을 매기지 않으면 기본값 1(=곧 열림)이라 **오늘 마감 카드보다 위로** 올라온다 —
     open 과의 비교만으로는 그 회귀를 못 잡는다(변이시험 실측). 같은 등급(2)끼리는 안정 정렬. */
  const order2 = CC.sortByAvailability([
    { id: 'd', state: 'daily_done' }, { id: 'w', state: 'weekend_unpublished' },
  ]).map(x => x.id).join(',');
  ok('★ 주말 미게시 카드는 모집중 카드 위로 올라오지 않는다', order === 'b,a');
  ok('★ 오늘 마감 카드와 같은 등급 — 원래 순서를 앞지르지 않는다', order2 === 'd,w');
}

console.log(failed ? `\ncampaignReopenWeekend: FAILED (${failed})` : '\ncampaignReopenWeekend: passed');
process.exit(failed ? 1 : 0);
