/**
 * weekendResetButton.test.js — [📅 인원] 「주말제외 재설정 / 주말포함 재설정」 버튼 회귀가드 (2026-09-26).
 *
 * 사고: 주말 설정을 바꾸면 안내문이 "[주말 기준으로 재배분]을 누르면…"이라고 말했지만 그 버튼이
 *       화면 어디에도 없어, 창을 한 번 닫으면 다시 재배치할 방법이 없었다. "재배분"이라는 말도
 *       무엇을 기준으로 다시 까는지 읽히지 않았다(사용자 확정: 이름 = 지금 주말 설정).
 * 고정: ① 대상일 때 버튼이 실제로 그려진다 ② 이름은 공고의 주말 설정을 따른다
 *       ③ 누르면 확인창이 먼저 뜨고, 직접 0명으로 바꾼 날도 채워진다는 경고를 말한다
 *       ④ 취소하면 아무것도 바뀌지 않는다 ⑤ 옛 이름("주말 기준으로 재배분")이 화면 문구에 없다.
 * 실행: node tests/weekendResetButton.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SRC = read('../frontend/js/campaign-daily-plan.js');

let failed = 0;
const ok = (msg, cond) => { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

const els = {};
const mk = id => ({ id, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
  getBoundingClientRect: () => ({}), querySelector: () => null, querySelectorAll: () => [],
  insertAdjacentHTML() {}, remove() {}, contains: () => true, innerHTML: '', textContent: '', disabled: false });
const confirms = [];
let confirmAnswer = true;
const win = { location: { hostname: 'x' }, addEventListener() {},
  confirm: m => { confirms.push(m); return confirmAnswer; },
  sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null } };
const doc = { head: mk('head'), body: mk('body'), createElement: () => mk(''),
  getElementById: id => (els[id] = els[id] || mk(id)),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
let OV = null;
const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  sessionStorage: win.sessionStorage, localStorage: win.localStorage,
  fetch: async () => ({ ok: true, json: async () => Object.assign({ ok: true }, OV) }) };
sb.globalThis = sb; win.document = doc;
vm.createContext(sb);
vm.runInContext(SRC, sb, { filename: 'campaign-daily-plan.js' });
const CDP = sb.window.CampaignDailyPlan;

const FRI = '2026-08-21';
const base = over => Object.assign({
  campaignId: 'c1', title: 'T', status: 'active', defaultDaily: 30, recruitTotal: 150,
  startDate: '2026-08-14', today: FRI, planEnabled: true, carryMode: 'auto', carryHeld: null,
  carryAppliedSum: 0, carryPending: 0, todaySubmitted: 0, todayNaturalQuota: 30,
  scheduleDriven: false, scheduleDates: null, worktableDates: [], worktableLinked: true,
  plans: [], byDateSubmitted: {}, todayUsed: 0, submittedAll: 0, rounds: [], roundsTotal: 0,
  roundsDrift: false, events: [],
}, over);
const body = () => (els.cdpBody && els.cdpBody.innerHTML) || '';

(async () => {
  console.log('[1] 버튼이 실제로 그려지고 이름은 주말 설정을 따른다');
  OV = base({ skipWeekends: true });
  await CDP.open('c1');
  ok('주말 제외 공고 → 「주말제외 재설정」 버튼', /id="cdpRebalBtn"[^>]*>↺ 주말제외 재설정</.test(body()));
  ok('버튼이 실제 동작 함수에 연결돼 있다', /onclick="CampaignDailyPlan\._rebalance\(\)"/.test(body()));

  OV = base({ skipWeekends: false });
  await CDP.open('c1');
  ok('주말 포함 공고 → 「주말포함 재설정」 버튼', />↺ 주말포함 재설정</.test(body()));

  OV = base({ skipWeekends: true, recruitTotal: 0 });
  await CDP.open('c1');
  ok('재설정 대상이 아니면(무제한) 버튼을 그리지 않는다', !/cdpRebalBtn/.test(body()));

  console.log('[2] 누르면 확인창 → 경고 → 취소 시 무변경');
  OV = base({ skipWeekends: true });
  await CDP.open('c1');
  confirms.length = 0; confirmAnswer = false;
  CDP._rebalance();
  ok('누르면 확인창이 먼저 뜬다', confirms.length === 1);
  ok('확인창이 "직접 0명으로 바꿔 둔 날도 다시 일건수로 채워집니다"를 말한다', /직접 0명으로 바꿔 둔 날도 다시 일건수로 채워집니다/.test(confirms[0] || ''));
  ok('취소하면 재설정되지 않는다(버튼이 그대로 남는다)', /cdpRebalBtn/.test(body()));

  confirmAnswer = true;
  CDP._rebalance();
  ok('확인하면 재설정 결과 안내가 뜬다', /주말제외 재설정<\/b> — 오늘 이후 일정을 다시 짰습니다/.test(body()));
  ok('결과 안내도 0명 날이 채워졌다는 사실을 말한다', /직접 0명으로 바꿔 둔 날도 일건수로 채워졌으니 확인하세요/.test(body()));
  ok('방금 재설정한 상태에서는 버튼을 다시 그리지 않는다', !/cdpRebalBtn/.test(body()));

  console.log('[3] 옛 이름 부재');
  const strs = SRC.replace(/^\s*\/\/.*$/gm, '');
  ok('화면 문구에 "주말 기준으로 재배분"이 없다(없는 버튼을 가리키던 안내)', !/주말 기준으로 재배분/.test(strs));
  ok('화면 문구에 없는 버튼 이름 "[자동 맞춤]"이 없다', !/'[^'\n]*\[자동 맞춤\][^'\n]*'/.test(strs));

  console.log(failed ? `weekendResetButton: FAILED (${failed})` : 'weekendResetButton: passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ 실행 실패: ' + (e && e.stack)); process.exit(1); });
