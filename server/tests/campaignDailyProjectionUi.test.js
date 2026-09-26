/**
 * campaignDailyProjectionUi.test.js — [📅 인원] 「예상 인원 방식」 화면을 vm 으로 실제 실행 (결정 182 · 2026-09-26)
 *
 * 사용자 확정: 날짜별 인원은 규칙이 정하고 화면은 그 계산을 보여 준다.
 *   · 바꾸는 즉시 다시 계산(저장 안 함 · 미리보기 요청) · 요약 = "총 N명 · 예상 종료일"
 *   · [재설정] = 직접 정한 날을 지우고 규칙으로(인트라넷 오더 휴무일 `오더휴무:` 은 남김)
 * 고정:
 *  ① 서버가 예상 인원(projection)을 주면 새 화면, 안 주거나 시트 일정 공고면 종전 화면
 *  ② ★★ 줄의 ＋/−·입력은 **그 줄의 날짜**를 바꾼다(줄 목록과 이벤트 목록이 같아야 한다 — 실제로 어긋났던 버그)
 *  ③ 바꾸면 미리보기만 요청하고(저장 0), 종료일 변화를 보여 준다 · 늦게 온 응답은 버린다
 *  ④ 저장은 바꾼 날(set)과 되돌린 저장값(remove)만 보낸다 — 규칙으로 나오는 날은 보내지 않는다
 *  ⑤ [재설정]은 직접 정한 날만 지우고 오더 휴무일은 남긴다 · 확인창이 먼저 뜬다
 *  ⑥ 이월 방식 변경 = 서버 저장 → 다시 불러오기(화면이 앞날을 따로 계산하지 않는다)
 * 실행: node tests/campaignDailyProjectionUi.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-daily-plan.js'), 'utf8');

let failed = 0;
const ok = (msg, cond, extra) => { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg + (extra ? ' :: ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 가짜 DOM: #cdpBody 를 새로 그리면 #cdpRows 도 새 요소(실제 DOM 처럼 이벤트가 쌓이지 않는다) ── */
const els = {};
const mk = id => {
  const e = { id, style: {}, dataset: {}, _h: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 100 }),
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {}, remove() {}, contains: () => true,
    textContent: '', disabled: false, _html: '' };
  Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; if (id === 'cdpBody') delete els.cdpRows; } });
  return e;
};
const confirms = [];
let confirmAnswer = true;
const win = { location: { hostname: 'x' }, addEventListener() {},
  confirm: m => { confirms.push(m); return confirmAnswer; },
  sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} } };
const doc = { head: mk('head'), body: mk('body'), createElement: () => mk(''),
  getElementById: id => (els[id] = els[id] || mk(id)),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };

/* ── 가짜 서버 ── */
const CALLS = [];
let OV = null, SAVED = null, PV = null, previewGate = null;
const reply = j => ({ ok: true, status: 200, json: async () => Object.assign({ ok: true }, j) });
const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  sessionStorage: win.sessionStorage, localStorage: win.localStorage,
  fetch: async (url, opt) => {
    const method = (opt && opt.method) || 'GET';
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    CALLS.push({ method, url: String(url), body });
    if (/daily-plan\/preview/.test(url)) {
      if (previewGate) { const g = previewGate(body); if (g) return g; }
      return reply(PV ? PV(body) : { projection: OV.projection });
    }
    if (method === 'POST' && /daily-plan$/.test(url)) return reply(SAVED || OV);
    if (method === 'PUT' && /carry-strategy/.test(url)) return reply({ carryStrategy: body.carryStrategy });
    return reply(OV);
  } };
sb.globalThis = sb; win.document = doc;
vm.createContext(sb);
vm.runInContext(SRC, sb, { filename: 'campaign-daily-plan.js' });
const CDP = sb.window.CampaignDailyPlan;

/* ── 데이터: 오늘 9/26(토) 부터 45일 · 매일 3명 · 9/27(일) 휴무 ── */
const TODAY = '2026-09-26';
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const DAYS = [];
for (let i = 0; i < 45; i++) {
  const d = addDays(TODAY, i);
  DAYS.push(d === '2026-09-27' ? { date: d, quota: 0, planned: null, closed: true }
    : d === '2026-10-03' ? { date: d, quota: 0, planned: 0, closed: true }       // 서버: 저장된 0명 = 닫힌 날
    : { date: d, quota: 3, planned: d === '2026-09-29' ? 3 : null, closed: false });
}
const proj = over => Object.assign({ today: TODAY, from: TODAY, days: DAYS, endDate: DAYS[DAYS.length - 1].date, remaining: 132, truncated: false }, over);
const base = over => Object.assign({
  campaignId: 'c1', title: 'T', status: 'active', defaultDaily: 3, recruitTotal: 150,
  startDate: '2026-09-20', today: TODAY, planEnabled: true, carryMode: 'auto', carryStrategy: 'next', carryHeld: null,
  carryAppliedSum: 0, carryPending: 0, todaySubmitted: 0, todayNaturalQuota: 3, skipWeekends: false,
  scheduleDriven: false, scheduleDates: null, worktableDates: [], worktableLinked: true,
  plans: [
    { date: '2026-09-29', count: 3, updatedBy: '관리자', updatedAt: '' },          // 직접 정한 날(규칙과 같은 값)
    { date: '2026-10-03', count: 0, updatedBy: '오더휴무:관리자', updatedAt: '' },  // 인트라넷 오더 휴무일
  ],
  byDateSubmitted: {}, todayUsed: 0, submittedAll: 18, rounds: [], roundsTotal: 0,
  roundsDrift: false, events: [], projection: proj(),
}, over);
const body = () => (els.cdpBody && els.cdpBody.innerHTML) || '';
/** 그려진 줄에서 날짜 → data-i 를 읽는다(화면이 실제로 붙인 번호) */
function idxOf(dateIso) {
  const md = Number(dateIso.slice(5, 7)) + '/' + Number(dateIso.slice(8, 10));
  const rows = body().split('<div class="cdp-row');
  for (const r of rows) {
    const lab = r.match(/<span class="cdp-d[^"]*"[^>]*>([^<]*)/);
    if (lab && lab[1].indexOf(md) === 0) { const m = r.match(/class="cdp-in" data-i="(\d+)"/); return m ? Number(m[1]) : -1; }
  }
  return -1;
}
function typeValue(dateIso, value) {
  const i = idxOf(dateIso);
  const inp = { dataset: { i: String(i) }, value: String(value), closest: s => (s === '.cdp-in' ? inp : null) };
  (els.cdpRows._h.change || []).forEach(f => f({ target: inp }));
  return i;
}
function clickReset(dateIso) {
  const i = idxOf(dateIso);
  const btn = { dataset: { i: String(i) }, closest: s => (s === '.cdp-reset' ? btn : null) };
  (els.cdpRows._h.click || []).forEach(f => f({ target: btn }));
}
const posts = re => CALLS.filter(c => c.method === 'POST' && re.test(c.url));

(async () => {
  console.log('[1] 서버가 예상 인원을 주면 새 화면');
  OV = base();
  await CDP.open('c1');
  ok('요약이 "총 150명 · 예상 종료일"', /총 <span class="num">150<\/span>명 · 예상 종료일 <b>11\/9/.test(body()), body().slice(0, 0));
  ok('합계 맞추기 막대 문구(건 적게 모집합니다)가 없다', !/건 적게 모집합니다/.test(body()));
  ok('안내가 "규칙으로 계산한 값 · 바꾼 날만 저장"', /규칙으로 계산한 값입니다\. 바꾼 날만 저장됩니다/.test(body()));
  ok('쉬는 날(9/27)은 휴무로 보인다', /9\/27[\s\S]{0,200}?<span class="cdp-state"[^>]*>휴무</.test(body()));
  ok('45일 + 오더 휴무일(10/3 은 이미 포함) 줄이 모두 그려진다', (body().match(/class="cdp-in"/g) || []).length === 45);
  ok('바꾼 게 없으면 저장 버튼이 잠긴다', els.cdpSaveBtn.disabled === true);
  ok('직접 정한 날(9/29)은 "직접 정한 값"으로 보인다', /9\/29[\s\S]{0,700}?직접 정한 값/.test(body()));
  ok('인트라넷 오더 휴무일(10/3)은 "조절"이 아니라 휴무로 보인다',
    /10\/3[\s\S]{0,200}?<span class="cdp-state"[^>]*>휴무</.test(body()) && /10\/3[\s\S]{0,700}?인트라넷 오더 휴무일/.test(body()));

  console.log('[2] ★★ 줄의 입력은 그 줄의 날짜를 바꾼다 · 바꾸면 미리보기만');
  CALLS.length = 0;
  const FAR = '2026-11-05';   // 40일 뒤 — 종전 목록(앞 N일)과 어긋나던 자리
  PV = b => ({ projection: proj({ endDate: '2026-11-12', days: DAYS.map(x => x.date === FAR ? Object.assign({}, x, { quota: 10, planned: true }) : x) }) });
  typeValue(FAR, 10);
  ok('바로 저장하지 않는다(저장 요청 0)', posts(/daily-plan$/).length === 0);
  ok('다시 계산 중 표시', /다시 계산 중/.test(body()));
  ok('★ 계산 중에는 저장이 잠긴다(옛 숫자로 저장 금지)', els.cdpSaveBtn.disabled === true);
  await sleep(320);
  const pv = posts(/daily-plan\/preview/);
  ok('미리보기 요청 1건(연타는 250ms 로 묶는다)', pv.length === 1, JSON.stringify(pv.map(x => x.body)));
  ok('★★ 바꾼 날짜가 정확히 11/5 다', pv[0] && JSON.stringify(pv[0].body.set) === JSON.stringify([{ date: FAR, count: 10 }]), JSON.stringify(pv[0] && pv[0].body));
  ok('예상 종료일 변화를 보여 준다(원래 11/9 → 변경됨)', /예상 종료일 <b>11\/12/.test(body()) && /원래 11\/9[^<]*→ 변경됨/.test(body()));
  ok('이제 저장 버튼이 열린다', els.cdpSaveBtn.disabled === false);

  console.log('[3] 늦게 온 미리보기 응답은 버린다');
  {
    const gates = [];
    previewGate = () => new Promise(res => gates.push(res));
    typeValue('2026-10-01', 5);
    await sleep(320);                        // 1번 요청 출발(응답 대기)
    typeValue('2026-10-02', 6);
    await sleep(320);                        // 2번 요청 출발
    previewGate = null;
    gates[1](reply({ projection: proj({ endDate: '2026-11-20' }) }));
    await sleep(5);
    gates[0](reply({ projection: proj({ endDate: '2026-11-01' }) }));
    await sleep(5);
    ok('나중 요청의 결과(11/20)가 남는다 — 먼저 보낸 요청이 늦게 와도 덮지 않는다', /예상 종료일 <b>11\/20/.test(body()), (body().match(/예상 종료일 <b>[^<]*/) || [])[0]);
  }

  console.log('[4] 저장은 바꾼 날만');
  CALLS.length = 0;
  await CDP._save();
  const sv = posts(/daily-plan$/);
  const sBody = sv[0] && sv[0].body;
  ok('저장 요청 1건', sv.length === 1);
  ok('★ set 은 바꾼 3일뿐(규칙으로 나오는 날은 보내지 않는다)',
    sBody && JSON.stringify(sBody.set.map(x => x.date).sort()) === JSON.stringify(['2026-10-01', '2026-10-02', FAR]), JSON.stringify(sBody));
  ok('remove 는 비어 있다', sBody && sBody.remove.length === 0);
  ok('이월 보류 반영량을 보내지 않는다(예상 인원 방식)', sBody && sBody.carryApply == null);
  ok('★ 새 화면 표식(clientMode:projection)을 싣는다 — 서버 배포 시차 가드', sBody && sBody.clientMode === 'projection');

  console.log('[5] [기본으로] — 저장값은 지워 규칙으로');
  OV = base();
  await CDP.open('c1');
  clickReset('2026-09-29');
  ok('9/29 가 "규칙으로 되돌림(저장 전)"', /9\/29[\s\S]{0,700}?규칙으로 되돌림\(저장 전\)/.test(body()));
  await sleep(320);
  CALLS.length = 0;
  await CDP._save();
  const r5 = posts(/daily-plan$/)[0];
  ok('저장 = remove [9/29] · set 없음', r5 && JSON.stringify(r5.body.remove) === JSON.stringify(['2026-09-29']) && r5.body.set.length === 0, JSON.stringify(r5 && r5.body));

  console.log('[6] [재설정] — 직접 정한 날만 지우고 오더 휴무일은 남긴다');
  OV = base();
  await CDP.open('c1');
  ok('재설정 버튼이 그려진다', /id="cdpRebalBtn"/.test(body()));
  confirms.length = 0; confirmAnswer = false;
  CDP._rebalance();
  ok('확인창이 먼저 뜬다', confirms.length === 1);
  ok('확인창이 "직접 정해 둔 날(1일)을 모두 지우고"라고 말한다(오더 휴무일은 세지 않는다)', /직접 정해 둔 날\(1일\)/.test(confirms[0] || ''));
  ok('확인창이 오더 휴무일은 그대로 둔다고 말한다', /인트라넷 오더에 적힌 휴무일은 그대로 둡니다/.test(confirms[0] || ''));
  ok('취소하면 아무것도 바뀌지 않는다', els.cdpSaveBtn.disabled === true);
  confirmAnswer = true;
  CDP._rebalance();
  ok('확인하면 "되돌렸습니다(저장 전)" 안내', /직접 정한 날 <b>1일<\/b>을 지우고 규칙으로 되돌렸습니다\(저장 전\)/.test(body()));
  await sleep(320);
  CALLS.length = 0;
  await CDP._save();
  const r6 = posts(/daily-plan$/)[0];
  ok('★ 저장 = remove [9/29] 만 — 오더 휴무일(10/3)은 남는다',
    r6 && JSON.stringify(r6.body.remove) === JSON.stringify(['2026-09-29']) && r6.body.set.length === 0, JSON.stringify(r6 && r6.body));

  console.log('[7] 이월 방식 변경 = 서버 저장 → 다시 불러오기');
  OV = base();
  await CDP.open('c1');
  CALLS.length = 0;
  OV = base({ carryStrategy: 'extend', projection: proj({ endDate: '2026-11-15' }) });
  await CDP._mode('extend');
  ok('PUT 뒤에 GET(다시 불러오기)', CALLS.length >= 2 && CALLS[0].method === 'PUT' && /carry-strategy/.test(CALLS[0].url)
    && CALLS[1].method === 'GET' && /daily-plan$/.test(CALLS[1].url), JSON.stringify(CALLS.map(c => c.method + ' ' + c.url)));
  ok('새 예상 종료일이 보인다', /예상 종료일 <b>11\/15/.test(body()));
  ok('화면이 앞날을 따로 계산하지 않는다(미리보기 요청 0)', posts(/daily-plan\/preview/).length === 0);

  console.log('[8] 예상 인원이 없으면 종전 화면');
  OV = base({ projection: undefined });
  await CDP.open('c1');
  ok('구버전 서버(예상 인원 없음) → 종전 화면', !/규칙으로 계산한 값입니다\. 바꾼 날만 저장됩니다/.test(body()) && /cdpRows/.test(body()));
  OV = base({ scheduleDriven: true });
  await CDP.open('c1');
  ok('시트 일정 공고 → 종전 화면', !/규칙으로 계산한 값입니다\. 바꾼 날만 저장됩니다/.test(body()));

  console.log(failed ? `campaignDailyProjectionUi: FAILED (${failed})` : 'campaignDailyProjectionUi: passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ 실행 실패: ' + (e && e.stack)); process.exit(1); });
