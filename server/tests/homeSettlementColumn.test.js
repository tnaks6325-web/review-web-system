/**
 * 홈 작업목록 「업체 정산」 칸 + [업체 미입금]·[계약 미매칭] 회귀가드 (결정 421 · 사용자 확정 2026-11-25 A안)
 *   A. 서버 묶음(homeSettlementSummary) — 진행 중/보관함 분리 · 같은 계약은 한 번만 조회 · 동시 조회 6건 상한 ·
 *      계약 조회 실패는 그 작업만 proxyDown · 공유 배지 재료 · 60초 다시 쓰기 + fresh 우회 · 마감 조회 실패 = 거절
 *   B. 단일 출처 — 홈 묶음의 칸 값 == 작업보드 정산 칸(settlementForTab)의 같은 칸 값
 *   C. 경로 — GET 전용 · 내부 직원(internalMiddleware)만
 *   D. 입금 판정 금액 기준 — 인트라넷이 일부만 들어와도 'paid' 로 저장하는 계약을 「입금완료」로 그리지 않는다
 *   E. 화면 — 칸 상태(받는 중·못 받음·계약 없음) · 미입금 판정 = 업체관리 칩과 같은 함수 · 합계는 계약당 한 번 ·
 *      거름·정렬 · 홈 칸에서 누른 버튼은 그 줄의 작업으로 열린다(작업보드 정산 상태를 덮지 않는다)
 * 실행: node tests/homeSettlementColumn.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/trackB.service');
const participants = require('../src/services/participants.service');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓ ' + m); };
const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}

// 작업 4개: R1·R2 진행 중(같은 계약 S1 공유) · R3 진행 중(계약 조회 실패 S9) · F1 마감(S2) · R4 진행 중 계약 없음
const TABS = [
  { sheetId: 'sl', tabName: 'R1', tabGid: '1' }, { sheetId: 'sl', tabName: 'R2', tabGid: '2' },
  { sheetId: 'sl', tabName: 'R3', tabGid: '3' }, { sheetId: 'sl', tabName: 'F1', tabGid: '4' },
  { sheetId: 'sl', tabName: 'R4', tabGid: '5' },
];
const LINKS = [
  { sheetId: 'sl', tabName: 'R1', salesId: 'S1', contractNumber: 'C-1' },
  { sheetId: 'sl', tabName: 'R2', salesId: 'S1', contractNumber: 'C-1' },
  { sheetId: 'sl', tabName: 'R3', salesId: 'S9', contractNumber: 'C-9' },
  { sheetId: 'sl', tabName: 'F1', salesId: 'S2', contractNumber: 'C-2' },
  { sheetId: 'other', tabName: 'X', salesId: 'S1', contractNumber: 'C-1' },   // 홈 범위 밖 작업이지만 같은 계약 공유
];
const INTRA = {
  // S1: 인트라넷 상태는 'paid' 인데 입금 300만 / 견적 500만 — 일부 입금
  S1: { sales: { id: 'S1', contract_number: 'C-1', amount: 5000000, payment_status: 'paid', payment_date: '2026-11-20', matched_bank_amount: 3000000, matched_bank_date: '2026-11-20', invoice_status: 'issued', invoice_date: '2026-11-18' },
        quotes: [{ id: 'q', quote_number: 'Q-1', status: 'accepted', quote_date: '2026-11-10', total_amount: 5000000 }], inv: [] },
  S2: { sales: { id: 'S2', contract_number: 'C-2', amount: 2000000, payment_status: 'paid', matched_bank_amount: 2000000, matched_bank_date: '2026-11-02', invoice_status: 'issued', invoice_date: '2026-11-01' },
        quotes: [{ id: 'q2', quote_number: 'Q-2', status: 'accepted', quote_date: '2026-10-28', total_amount: 2000000 }], inv: [] },
  // S9: 계약 조회가 실패한다
};
let calls = [], inFlight = 0, maxInFlight = 0;
global.fetch = async (url) => {
  const u = String(url); calls.push(u);
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise(r => setImmediate(r));
  inFlight--;
  let m = u.match(/\/api\/tables\/sales\/(\w+)/);
  if (m) { if (!INTRA[m[1]]) throw new Error('intranet down'); return { ok: true, json: async () => ({ data: INTRA[m[1]].sales }) }; }
  m = u.match(/\/api\/tables\/quotes\?where=sales_id=(\w+)/);
  if (m) { if (!INTRA[m[1]]) throw new Error('intranet down'); return { ok: true, json: async () => ({ data: INTRA[m[1]].quotes }) }; }
  m = u.match(/\/api\/tables\/tax_invoices\?where=sales_id=(\w+)/);
  if (m) return { ok: true, json: async () => ({ data: (INTRA[m[1]] || {}).inv || [] }) };
  return { ok: true, json: async () => ({ data: [] }) };
};
let finFails = false;
const svcPool = () => pool([
  [/FROM trackb_tab_finished WHERE deleted_at IS NULL/, () => { if (finFails) throw new Error('fin boom'); return { rows: [{ sheetId: 'sl', tabName: 'F1', tabGid: '4', finishedAt: '2026-11-10', finishedBy: '자동 마감' }] }; }],
  [/FROM trackb_settlement_links WHERE deleted_at IS NULL$/, () => ({ rows: LINKS })],
  [/FROM trackb_settlement_links l LEFT JOIN tab_configs tc .*sales_id = ANY/, (_s, p) => ({ rows: LINKS.filter(l => p[0].includes(l.salesId)).map(l => ({ ...l, label: l.tabName })) })],
  [/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/, (_s, p) => ({ rows: LINKS.filter(l => l.sheetId === p[0] && l.tabName === p[1]).map(l => ({ salesId: l.salesId, contractNumber: l.contractNumber, linkedBy: 'x' })) })],
  [/FROM trackb_settlement_links l LEFT JOIN tab_configs tc .*sales_id = \$1/, (_s, p) => {
    const others = LINKS.filter(l => l.salesId === p[0] && !(l.sheetId === p[1] && l.tabName === p[2]));
    return { rows: others.map(l => ({ sheetId: l.sheetId, tabName: l.tabName, label: l.tabName, total: others.length })) };
  }],
]);

async function serverPart() {
  console.log('A. 서버 묶음');
  participants.__setPoolForTest(pool([[/WITH raw_tabs AS/, () => ({ rows: TABS.map(t => ({ ...t })) })]]));
  svc.__setPoolForTest(svcPool());
  calls = []; maxInFlight = 0;
  const run = await svc.homeSettlementSummary({ role: 'staff', staffName: '직원', scope: 'run', force: true });
  const by = Object.fromEntries(run.map(x => [x.tabName, x]));
  ok(Object.keys(by).sort().join() === 'R1,R2,R3', '진행 중 묶음 = 계약이 매칭된 진행 중 작업만(마감·계약 없음·범위 밖 작업 제외)');
  ok(calls.filter(u => /\/sales\/S1/.test(u)).length === 1, '같은 계약(S1)을 나눠 쓰는 두 작업이어도 인트라넷엔 한 번만 묻는다');
  ok(maxInFlight <= 6, `인트라넷 동시 조회는 6건 이하(${maxInFlight})`);
  ok(by.R3.proxyDown === true && by.R1.proxyDown === false, '계약 조회 실패는 그 작업만 「확인 필요」(proxyDown) — 다른 작업은 멀쩡');
  ok(by.R1.totalCost === 5000000 && by.R1.paidAmount === 3000000, '총비용 = 견적 합계 · 입금액 = 인트라넷 입금 누계');
  ok(by.R1.sharedTabCount === 3 && by.R1.sharedTabs.map(s => s.tabName).sort().join() === 'R2,X', '공유 배지 재료 — 같은 계약을 함께 쓰는 다른 작업(범위 밖 작업 포함 전체 수)');
  const fin = await svc.homeSettlementSummary({ role: 'admin', scope: 'fin', force: true });
  ok(fin.length === 1 && fin[0].tabName === 'F1', '보관함 묶음 = 마감된 작업만');
  calls = [];
  await svc.homeSettlementSummary({ role: 'admin', scope: 'run' });
  ok(calls.length === 0, '60초 안에는 받아 둔 값을 다시 쓴다(인트라넷 조회 0)');
  await svc.homeSettlementSummary({ role: 'admin', scope: 'run', force: true });
  ok(calls.length > 0, 'fresh(계약 매칭 직후)는 저장분을 건너뛰고 새로 묻는다');
  finFails = true;
  let threw = false;
  try { await svc.homeSettlementSummary({ role: 'admin', scope: 'run', force: true }); } catch (_) { threw = true; }
  ok(threw, '마감 여부를 못 읽으면 진행 중/보관함을 섞어 내보내지 않고 실패한다');
  finFails = false;

  console.log('B. 단일 출처 — 작업보드 정산 칸과 같은 값');
  svc.__setPoolForTest(svcPool());
  const one = await svc.settlementForTab({ sheetId: 'sl', tabName: 'R1', role: 'admin' });
  for (const k of ['linked', 'contractNumber', 'salesId', 'proxyDown', 'quote', 'quoteLookupFailed', 'invoice', 'totalCost', 'payment', 'amount', 'paidAmount', 'paidDate', 'sharedTabCount'])
    assert.deepStrictEqual(by.R1[k], one[k], `칸 ${k} 가 작업보드와 다르다`);
  ok(true, '홈 묶음의 칸 값 13가지가 작업보드 정산 칸(settlementForTab)과 같다');
  const SVC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
  ok((SVC.match(/function _settlementTabView\(/g) || []).length === 1 && (SVC.match(/[^n] _settlementTabView\(\{|\._settlementTabView\(\{|= _settlementTabView\(\{/g) || []).length === 2,
    '표시값을 만드는 함수는 한 벌(_settlementTabView) — 두 경로가 함께 부른다');

  console.log('C. 경로');
  const router = require('../src/routes/trackB.routes');
  const layer = (router.stack || []).filter(l => l.route && l.route.path === '/home/settlement');
  ok(layer.length === 1 && layer[0].route.methods.get === true && !layer[0].route.methods.post, 'GET /home/settlement 하나만(읽기 전용)');
  ok(/router\.get\('\/home\/settlement', authMiddleware, internalMiddleware/.test(ROUTES), '내부 직원만(광고주·리뷰어 차단)');
  participants.__setPoolForTest(null); svc.__setPoolForTest(null);
}

function grab(name) {
  const m = new RegExp('\\n(?:async )?function ' + name + '\\s*\\(').exec(WD);
  assert(m, name + ' 을 찾지 못했다');
  const st = WD.indexOf('{', m.index + name.length + 10);
  let d = 0, i = st;
  for (; i < WD.length; i++) { const c = WD[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  return WD.slice(m.index, i + 1) + '\n';
}

function screenPart() {
  console.log('D. 입금 판정 — 금액 기준');
  const names = ['_setlPayState', 'setlSummaryHtml', '_awMD', '_manWon', '_shareBadge', '_wonFmt', '_homeSetlBag', '_homeSetlOf', '_setlIsUnpaid',
    '_setlUnpaidRest', '_homeSetlMatch', '_homeSetlSumHtml', '_homeSetlChipsHtml', '_homeSetlCellHtml', '_homeSetlCtx', '_finVisible', '_openSettlementPaymentFor', 'openSettlementDocument'];
  const modal = [];
  const box = {
    STATE: { role: 'admin', tabs: [], finTab: 'run', finFilter: '', finQ: '', finMgr: '' },
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    isFinished: t => !!t.finished, _tabSearchText: t => t.tabName, _finMatchFilter: () => true, _finUnpaid: () => 0,
    _modal: (title, body) => modal.push({ title, body }), awDocOpen: () => {}, openSettlementPayment: () => modal.push({ title: 'WORKDESK' }),
  };
  vm.createContext(box);
  vm.runInContext('const _SETTLE_PAY={unpaid:[\'미입금\',\'bad\'],partial:[\'부분입금\',\'warn\'],paid:[\'입금완료\',\'safe\']};\n' + names.map(grab).join(''), box);
  const PART = { linked: true, totalCost: 5000000, paidAmount: 3000000, payment: { status: 'paid', date: '2026-11-20' }, paidDate: '2026-11-20', invoice: { status: 'issued', date: '2026-11-18' }, quote: { quoteNumber: 'Q', quoteDate: '2026-11-10', count: 1, acceptedCount: 1 } };
  ok(box._setlPayState(PART) === 'partial', '인트라넷 상태가 paid 여도 입금 300만 < 총비용 500만이면 일부 입금');
  const html = box.setlSummaryHtml(PART);
  ok(/tp3doc part[^>]*>[\s\S]*?입금<span class="tp3sub">300만 \/ 500만/.test(html) && !/입금완료/.test(html), '작업보드·홈 입금 칸 = 「300만 / 500만」(종전 「입금완료」 아님)');
  ok(box._setlPayState({ ...PART, paidAmount: 5000000 }) === 'paid', '다 들어오면 입금완료');
  ok(box._setlPayState({ linked: true, totalCost: null, paidAmount: 0, payment: { status: 'paid' } }) === 'paid', '총비용을 모르면 종전처럼 인트라넷 상태를 쓴다');
  ok(box._setlPayState({ linked: true, totalCost: 5000000, paidAmount: 0, payment: { status: 'unpaid' } }) === 'unpaid', '한 푼도 안 들어왔으면 미입금');

  console.log('E. 홈 칸·거름');
  const t = (n, o) => ({ sheetId: 'sl', tabName: n, stats: {}, ...o });
  const A = t('A'), B = t('B'), Cc = t('C'), D = t('D'), E = t('E'), F = t('F', { finished: true });
  box.STATE.tabs = [A, B, Cc, D, E, F];
  ok(box._homeSetlOf(A) === null, '받기 전 = null → 칸은 작업보드와 같은 「…」');
  box.STATE.homeSettle = { run: { failed: true, at: 1 }, fin: null };
  const fail = box._homeSetlOf(A);
  ok(fail.proxyDown === true && fail.linked === true, '못 받으면 「확인 필요」(미입금·계약 없음으로 꾸미지 않는다)');
  ok(/disabled[^>]*>업체 미입금 …/.test(box._homeSetlChipsHtml(box.STATE.tabs)), '못 받으면 거름 단추는 꺼지고 숫자 대신 「…」 + 사유');
  box.STATE.homeSettle = { run: { at: 1, map: {
    'sl\tA': { linked: true, salesId: 'S1', totalCost: 5000000, paidAmount: 3000000 },   // 200만 남음(S1)
    'sl\tB': { linked: true, salesId: 'S1', totalCost: 5000000, paidAmount: 3000000 },   // 같은 계약
    'sl\tC': { linked: true, salesId: 'S3', totalCost: 1000000, paidAmount: 0 },         // 100만
    'sl\tD': { linked: true, salesId: 'S4', totalCost: 800000, paidAmount: 800000 },     // 완납
    // E: 계약 없음
  } }, fin: null };
  ok(box._homeSetlOf(E).linked === false, '계약이 없는 작업 = linked:false → 칸에 [계약 매칭]');
  ok(/계약 매칭/.test(box._homeSetlCellHtml(E, 4)) && /data-setl-i="4"/.test(box._homeSetlCellHtml(E, 4)), '칸은 작업보드 렌더러 그대로 + 줄 번호만 붙는다');
  ok(box._setlIsUnpaid({ linked: true, proxyDown: true, totalCost: 1, paidAmount: 0 }) === false, '조회 실패는 미입금으로 세지 않는다');
  const chips = box._homeSetlChipsHtml(box.STATE.tabs);
  ok(/업체 미입금 3/.test(chips) && /계약 미매칭 1/.test(chips), '건수는 진행 중 탭 작업만(마감 F 제외) — 미입금 3 · 미매칭 1');
  box.STATE.homeSetlF = 'unpaid';
  const vis = box._finVisible();
  ok(vis.map(x => x.tabName).join() === 'A,B,C', '[업체 미입금] = 미입금 작업만, 남은 돈 큰 순');
  ok(/업체 미입금 <b>3건<\/b> · 남은 금액 합계 <b>3,000,000원<\/b>/.test(box._homeSetlSumHtml(box.STATE.tabs)), '합계는 같은 계약을 한 번만 더한다(200만 + 100만 = 300만, 두 배 아님)');
  box.STATE.homeSetlF = 'nomatch';
  ok(box._finVisible().map(x => x.tabName).join() === 'E', '[계약 미매칭] = 계약 없는 작업만');
  box.STATE.homeSetlF = '';
  ok(/function _ovmRowMatch\(t,f,q\)\{[\s\S]{0,400}f==='unpaid' && !_setlIsUnpaid\(st\)/.test(WD), '업체관리 「미입금」 칩도 같은 판정 함수를 쓴다(사본 0)');

  // 홈 칸에서 누른 입금 버튼 → 그 줄의 작업 · 작업보드 정산 상태(STATE.settle)는 그대로
  box.STATE.settle = { data: { linked: true }, tab: { tabName: '작업보드에 열어 둔 작업' } };
  const td = { getAttribute: k => (k === 'data-setl-i' ? '2' : null) };
  const ev = { stopPropagation() {}, preventDefault() {}, target: { closest: sel => (sel === 'td[data-setl-i]' ? td : null) } };
  box.openSettlementDocument(ev, 'payment');
  ok(modal.length === 1 && /입금 — C/.test(modal[0].title), '홈 칸의 입금 버튼은 그 줄 작업(C)의 입금 창을 연다');
  ok(box.STATE.settle.tab.tabName === '작업보드에 열어 둔 작업', '작업보드에 열어 둔 정산 상태를 덮지 않는다');
  modal.length = 0;
  box.openSettlementDocument({ stopPropagation() {}, preventDefault() {}, target: { closest: () => null } }, 'payment');
  ok(modal.length === 1 && modal[0].title === 'WORKDESK', '작업보드 칸에서 누르면 종전 경로 그대로');
  ok(/const st=\(ev&&_homeSetlCtx\(ev\)\)\|\|STATE\.settle/.test(WD), '[계약 매칭] 도 홈 칸이면 그 줄 작업으로 연다');
  ok(/STATE\.homeSettle=\{run:null,fin:null\};/.test(grab('_contractMatchApplied')), '계약 매칭/해제 직후 홈 묶음을 버리고 새로 받는다(옛 계약 금액이 남지 않게)');
  ok(!/_finRenderList\(\)/.test(grab('_homeSetlRefresh')) && !/_finRenderList\(\)/.test(grab('_homeSetlLoad')),
    '★ 정산이 늦게 도착해도 머리줄(검색칸)을 다시 그리지 않는다 — 한글 입력이 깨지지 않게');
}

(async () => {
  await serverPart();
  screenPart();
  console.log(`\nhomeSettlementColumn: ${pass} passed`);
})().catch(e => { console.error('❌', e && e.message); process.exit(1); });
