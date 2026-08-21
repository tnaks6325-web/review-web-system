/**
 * campaignWeekendRebalance.test.js — 주말 포함/제외 전환 시 모집 일정 재배분(①②).
 *
 * 요청(2026-08-21):
 *   ① 주말포함 → 주말제외: 토/일 인원을 0 으로 하고 그만큼 뒤 평일로 밀어 총량 유지 · 작업보드 반영
 *   ② 주말제외 → 주말포함: 뒤에 붙어 있던 날을 0 으로 닫고 토/일에 배치 · 총량 유지 · 작업보드 반영
 *
 * ★★ 이 가드가 고정하는 불변식
 *   ① 총량 불변 — 어느 방향이든 배분 합계 = 배분해야 할 인원(총량 − 어제까지 확정).
 *   ② **제안까지만** — 재배분은 화면에 펼치기만 하고 저장 API 를 부르지 않는다(사람이 [확정 저장]).
 *   ③ 하한 = 오늘 확정·진행 + **이미 채워진 작업표 줄** — 그 아래 계획은 서버 재구성이 통째로
 *      거부(worktable_rebuild_below_used)하므로 애초에 만들지 않는다. 판정은 minFor 하나.
 *   ④ 구간 뒤에 남는 자리는 **해제가 아니라 명시 0** — 해제하면 작업표 행 수가 다시 기준이 된다.
 *   ⑤ 시트 일정 공고·무제한·하루 전량 공고는 대상이 아니다(사유를 말한다).
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

/* ── 모듈 vm 적재 ─────────────────────────────────────────── */
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
  getBoundingClientRect: () => ({}), querySelector: () => null, querySelectorAll: () => [],
  insertAdjacentHTML() {}, remove() {}, contains: () => true, innerHTML: '', textContent: '' });
const win = { location: { hostname: 'x' }, addEventListener() {}, confirm: () => true,
  sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null } };
// ★ getElementById 가 요소를 돌려줘야 open→재배분→[확정 저장] 전 흐름을 실제로 돌릴 수 있다
const doc = { head: el(), body: el(), createElement: () => el(), getElementById: () => el(),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
const NET = { overview: null, posts: [] };
const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout,
  sessionStorage: win.sessionStorage, localStorage: win.localStorage,
  fetch: async (url, opt) => {
    if (opt && opt.method === 'POST') NET.posts.push({ url: String(url), body: JSON.parse(opt.body || '{}') });
    return { ok: true, json: async () => Object.assign({ ok: true }, NET.overview) };
  } };
sb.globalThis = sb; win.document = doc;
vm.createContext(sb);
vm.runInContext(read('../frontend/js/campaign-daily-plan.js'), sb, { filename: 'campaign-daily-plan.js' });
const CDP = sb.window.CampaignDailyPlan;

const FRI = '2026-08-21', SAT = '2026-08-22', SUN = '2026-08-23', MON = '2026-08-24';
const isWeekend = d => {
  const w = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
  return w === 0 || w === 6;
};
const spread = o => CDP._wkSpread(Object.assign({ from: FRI, today: FRI, closed: () => false }, o));
const sum = r => Object.keys(r.plan).reduce((s, d) => s + r.plan[d], 0);

/* ── [1] 총량 유지 · 양방향 ────────────────────────────────── */
console.log('\n[1] 재배분 — 총량 유지');
{
  const incl = spread({ target: 100, daily: 30 });
  ok('주말 포함 — 금30 토30 일30 월10(연달아 채운다)',
    incl.plan[FRI] === 30 && incl.plan[SAT] === 30 && incl.plan[SUN] === 30 && incl.plan[MON] === 10);
  ok('★★ ② 총량 유지 — 배분 합계 = 배분해야 할 인원', sum(incl) === 100 && incl.last === MON);

  const excl = spread({ target: 100, daily: 30, closed: isWeekend });
  ok('★★ ① 주말 제외 — 토/일 0 · 뒤 평일로 밀린다',
    excl.plan[SAT] === 0 && excl.plan[SUN] === 0
    && excl.plan[FRI] === 30 && excl.plan[MON] === 30 && excl.plan['2026-08-25'] === 30 && excl.plan['2026-08-26'] === 10);
  ok('★★ ① 총량 유지 — 종료일만 뒤로 밀린다(8/24 → 8/26)',
    sum(excl) === 100 && excl.last === '2026-08-26');
  ok('★ 주말이 표에서 사라지지 않는다(0 으로 보인다 — 왜 안 여는지가 보여야 한다)',
    excl.dates.indexOf(SAT) >= 0 && excl.dates.indexOf(SUN) >= 0);
}

/* ── [2] 뒤에 남은 자리 닫기(②의 핵심) ────────────────────── */
console.log('\n[2] 구간 뒤 자리 닫기');
{
  // 주말 제외로 8/26 까지 늘어나 있던 공고를 주말 포함으로 되돌리면 8/25·8/26 이 남는다
  const r = spread({ target: 100, daily: 30, tail: [SAT, SUN, MON, '2026-08-25', '2026-08-26'] });
  ok('★★ 구간 뒤 날짜는 **명시 0** 으로 닫는다(해제하면 작업표 행 수가 다시 기준이 된다)',
    r.plan['2026-08-25'] === 0 && r.plan['2026-08-26'] === 0 && r.shut.length === 2);
  ok('★ 총량은 그대로(닫은 날은 0 이라 합계에 영향 없음)', sum(r) === 100);
  ok('★ 구간 안의 tail 날짜는 다시 닫지 않는다(이미 배분됨)', r.plan[SAT] === 30);
}

/* ── [3] 하한 — 이미 채워진 줄은 닫지 못한다 ──────────────── */
console.log('\n[3] 하한(확정·채워진 줄)');
{
  const r = spread({ target: 100, daily: 30, closed: isWeekend, floorFor: d => (d === SAT ? 4 : 0) });
  ok('★★ 이미 참여·주문이 있는 토요일은 0 으로 닫지 않는다(서버 재구성 거부 회피)',
    r.plan[SAT] === 4 && r.kept.indexOf(SAT) >= 0);
  ok('★ 그 4명도 총량 안에서 센다(중복 배분 없음)', sum(r) === 100);

  const t = spread({ target: 20, daily: 30, floor: 12 });
  ok('★ 오늘 하한(확정·진행)은 목표보다 우선한다', t.plan[FRI] === 12 || t.plan[FRI] === 20);

  const tail = spread({ target: 60, daily: 30, tail: ['2026-08-30'], floorFor: d => (d === '2026-08-30' ? 3 : 0) });
  ok('★ 구간 뒤 날짜도 채워진 줄이 있으면 0 으로 닫지 않는다',
    tail.plan['2026-08-30'] === 3 && tail.shut.indexOf('2026-08-30') < 0 && tail.kept.indexOf('2026-08-30') >= 0);
}

/* ── [4] 경계 ─────────────────────────────────────────────── */
console.log('\n[4] 경계');
{
  ok('★★ 저장 상한(120일) 안에서 총량을 못 채우면 null — 반쪽 배분을 만들지 않는다',
    spread({ target: 100000, daily: 1, closed: isWeekend }) === null);
  const k = spread({ from: '2026-08-25', today: FRI, target: 30, daily: 30, keep: { [SAT]: 7 } });
  ok('★ 시작일이 미래인 공고의 today ≤ d < 시작일 저장분은 손대지 않는다(조용한 삭제 금지)',
    k.plan[SAT] === 7 && k.plan['2026-08-25'] === 30);
  const zero = spread({ target: 0, daily: 30 });
  ok('배분할 인원이 없으면 첫날 0(빈 계획) — 예외 없이 끝난다', zero && zero.plan[FRI] === 0);
}

/* ── [5] 제안까지만 — 조용한 자동 저장 금지 ───────────────── */
console.log('\n[5] 제안까지만');
{
  const src = read('../frontend/js/campaign-daily-plan.js');
  const body = src.slice(src.indexOf('async function openWeekendRebalance'), src.indexOf('function _rebalance'));
  ok('★★ 재배분은 저장 API 를 부르지 않는다(사람이 [확정 저장]을 눌러야 반영)',
    !/_req\(|daily-plan'|_save\(/.test(body) && /applyWeekendPlan\(\)/.test(body));
  const rb = src.slice(src.indexOf('function applyWeekendPlan'), src.indexOf('/* 자동 맞춤'));
  ok('★ 펼치기만 한다 — 화면 상태만 바꾸고 서버 호출 0', !/_req\(|fetch\(/.test(rb));
  ok('★ 저장·재조회하면 배너를 지운다(“저장 전”이라는 말이 거짓이 되지 않게)',
    /S\.rebalanced = null; S\.wkPrompt = false;/.test(src));
}

/* ── [6] 판정 단일 출처 ───────────────────────────────────── */
console.log('\n[6] 판정 단일 출처');
{
  const src = read('../frontend/js/campaign-daily-plan.js');
  ok('★ 주말 판정은 policyClosed 하나 — baseFor 와 재배분이 같은 것을 본다',
    /function policyClosed\(d\)/.test(src)
    && /function baseFor\(d\) \{\n\s+if \(policyClosed\(d\)\) return 0;/.test(src)
    && /closed: policyClosed/.test(src));
  ok('★★ 하한은 minFor 하나 — 드래그·−/＋·자동 맞춤·재배분이 같은 판정',
    /floorFor: minFor/.test(src)
    && /function minFor\(d\) \{[\s\S]{0,240}worktableFilledFor\(d\)/.test(src));
  ok('★ 시트 일정 공고는 재배분 대상이 아니다(날짜를 시트가 정한다)',
    /if \(j\.scheduleDriven === true\) return 'schedule_driven';/.test(src));
  ok('★ 무제한·하루 전량(블로그 등)·총원 충족·오늘 초과도 사유를 말한다',
    /unlimited/.test(src) && /single_day/.test(src) && /full:/.test(src) && /today_over/.test(src));
}

/* ── [7] 서버 재료 ────────────────────────────────────────── */
console.log('\n[7] 서버 재료(채워진 줄 수)');
{
  const sd = read('src/services/sheetlessDailyPlan.service.js');
  ok("★ 채워진 줄 판정은 utils/rowNumbering.isFilledRow 단일 출처(사본 금지)",
    /require\('\.\.\/utils\/rowNumbering'\)/.test(sd) && /isFilledRow\(rows\[i\]\)/.test(sd));
  ok('★ 판정에 필요한 네 칸을 실제로 읽어 온다(SELECT 에 없으면 전부 빈 줄로 센다)',
    /SELECT row_json, order_submission_id, reviewer_name, recipient_name, phone8/.test(sd));
  ok('filledByDate 를 함께 돌려준다', /return \{ ok: true, byDate, filledByDate,/.test(sd));
  const cp = read('src/services/campaignPlan.service.js');
  ok('getPlanOverview 가 worktableDates 에 filled 를 싣는다',
    /filled: \(read\.filledByDate \|\| \{\}\)\[date\] \|\| 0/.test(cp));
}

/* ── [8] 화면 배선 ────────────────────────────────────────── */
console.log('\n[8] 배선');
{
  const rec = read('../frontend/js/index-recruit.js');
  ok('★ 주말 설정이 **바뀌었을 때만** 재배분안을 연다(신규 발행·미변경은 무동작)',
    /_wkBefore !== _wkAfter/.test(rec) && /_wasEdit && newCampId/.test(rec));
  ok('★ 참여형 공고만 · 로드 실패면 열지 않는다(모르는 값으로 재배분 금지)',
    /participation_mode === true/.test(rec) && /!window\._recruitEditLoadFailed/.test(rec));
  ok('★ 모듈이 없으면 무동작(구버전 호스트 동작 불변)',
    /window\.CampaignDailyPlan && typeof window\.CampaignDailyPlan\.openWeekendRebalance === "function"/.test(rec));
  ok('★ 저장 안내 목록에 "주말 포함 여부"가 있다(바뀐 걸 말하지 않으면 제안이 뜬금없다)',
    /\["skip_weekends",\s+"주말 포함 여부"\]/.test(rec));
  ok('모듈이 진입점을 노출한다', typeof CDP.openWeekendRebalance === 'function' && typeof CDP._rebalance === 'function');
}

/* ── [9] 전 흐름 실행 — 저장 payload 가 구간 전체를 담는가 ─────
   ★★ 실브라우저가 잡은 결함: 종전 규칙("손대지 않은 값은 안 보낸다")이면 **주말이 통째로
     빠진다**(주말 제외 공고의 토요일은 baseFor 가 정책상 0 이라 "변경 없음"이 된다). 그러면
     그 날짜가 저장 계획에 없어 작업표 재구성이 그 빈 줄을 옮기지 못하고 뒤에 새 줄만 만들어
     **총 줄 수가 늘어난다**. 목적지 날짜도 같은 이유로 계획에 있어야 한다. */
console.log('\n[9] 저장 payload(전 흐름 실행)');
(async () => {
  const OV = (over) => Object.assign({
    campaignId: 'c1', title: 'T', status: 'active', defaultDaily: 30, recruitTotal: 150,
    startDate: '2026-08-14', today: FRI, planEnabled: true, carryMode: 'auto', carryHeld: null,
    carryAppliedSum: 0, carryPending: 0, todaySubmitted: 0, todayNaturalQuota: 30,
    scheduleDriven: false, scheduleDates: null, worktableDates: [], worktableLinked: true,
    plans: [], byDateSubmitted: {}, todayUsed: 0, submittedAll: 0, rounds: [], roundsTotal: 0,
    roundsDrift: false, events: [],
  }, over);
  const wt = d => d.map(x => ({ date: x, slots: 30, filled: 0 }));

  NET.overview = OV({ skipWeekends: true, worktableDates: wt([FRI, SAT, SUN, MON, '2026-08-25']) });
  NET.posts = [];
  await CDP.openWeekendRebalance('c1');
  await CDP._save();
  var post = NET.posts.find(x => /daily-plan/.test(x.url));
  var set = (post && post.body.set) || [];
  var at = d => { var h = set.find(x => x.date === d); return h ? h.count : null; };
  ok('★★ ① 주말(0명)이 저장 계획에 실린다 — 빠지면 작업표의 토/일 빈 줄이 그대로 남는다',
    at(SAT) === 0 && at(SUN) === 0);
  ok('★★ ① 옮겨 갈 목적지 날짜도 실린다(재구성 풀에 들어가야 줄이 이동한다)',
    at('2026-08-26') === 30 && at('2026-08-27') === 30);
  ok('★ 저장 합계 = 총량(150)', set.reduce(function (s2, x) { return s2 + x.count; }, 0) === 150);
  ok('★ 해제(remove)로는 내보내지 않는다 — 해제하면 작업표 행 수가 다시 기준이 된다',
    !(post && post.body.remove || []).length);

  NET.overview = OV({ skipWeekends: false, worktableDates: wt([FRI, MON, '2026-08-25', '2026-08-26', '2026-08-27']),
    plans: [FRI, MON, '2026-08-25', '2026-08-26', '2026-08-27'].map(d => ({ date: d, count: 30, updatedBy: 'a', updatedAt: '' })) });
  NET.posts = [];
  await CDP.openWeekendRebalance('c1');
  await CDP._save();
  post = NET.posts.find(x => /daily-plan/.test(x.url));
  set = (post && post.body.set) || [];
  ok('★★ ② 토/일이 열리고 뒤에 남아 있던 날은 0 으로 닫힌다',
    at(SAT) === 30 && at(SUN) === 30 && at('2026-08-26') === 0 && at('2026-08-27') === 0);

  console.log(failed ? `\ncampaignWeekendRebalance: FAILED (${failed})` : '\ncampaignWeekendRebalance: passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ [9] 실행 실패: ' + (e && e.message)); process.exit(1); });
