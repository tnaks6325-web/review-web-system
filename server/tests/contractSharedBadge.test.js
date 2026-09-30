/**
 * 계약 1건을 작업 여러 개가 함께 쓸 때의 표시(사용자 확정 2026-09-23 「1번」) 회귀가드.
 *   금액은 나누지 않는다 — 각 작업 줄은 계약 전체 금액 그대로 + "🔗 작업 N개 공유" 배지.
 *   합계(업체 화면 대시보드)만 같은 계약을 한 번 센다.
 *   A. settlementSummaryForAdvertiser — sharedTabCount(전체 활성 링크 기준, 조회 실패 시 목록 안에서 셈)
 *   B. settlementForTab — 내부만 sharedTabs(다른 작업 이름) 동봉, 광고주는 조회조차 안 함, 실패는 필드 미동봉
 *   C. advertiserWorkSummary — 보이는 작업 안에서만 세고, 계약 ID 대신 불투명 shareGroup
 *   D. 화면 — 배지 단일 출처·합계 중복 제거(vm 실행) + 배선
 * 실행: node tests/contractSharedBadge.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/trackB.service');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}

async function run() {
  const savedFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (/\/api\/tables\/sales\/SA1/.test(u)) return { ok: true, json: async () => ({ data: { id: 'SA1', contract_number: 'C-1', amount: 10000000, matched_bank_amount: 4000000, payment_status: 'unpaid', invoice_status: 'not_issued' } }) };
    if (/\/api\/tables\/sales\/SB2/.test(u)) return { ok: true, json: async () => ({ data: { id: 'SB2', contract_number: 'C-2', amount: 500000, matched_bank_amount: 0 } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const own = [
    { sheetId: 'S', tabName: 'A', salesId: 'SA1', contractNumber: 'C-1' },
    { sheetId: 'S', tabName: 'B', salesId: 'SA1', contractNumber: 'C-1' },
    { sheetId: 'S', tabName: 'C', salesId: 'SB2', contractNumber: 'C-2' },
    { sheetId: 'S', tabName: 'D', salesId: null },
  ];

  // ═══ A. 업체관리 요약 ═══
  let p = pool([
    [/WITH own AS/, () => ({ rows: own })],
    [/GROUP BY sales_id/, (s, prm) => { ok(Array.isArray(prm[0]) && prm[0].includes('SA1') && prm[0].includes('SB2'), 'A0: 링크된 계약만 한 번에 센다'); return { rows: [{ salesId: 'SA1', n: 3 }, { salesId: 'SB2', n: 1 }] }; }],
  ]);
  svc.__setPoolForTest(p);
  let items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'ADV' });
  const by = Object.fromEntries(items.map(i => [i.tabName, i]));
  ok(by.A.sharedTabCount === 3 && by.B.sharedTabCount === 3, 'A1: 전체 활성 링크 기준(다른 업체 작업 포함) 3');
  ok(by.C.sharedTabCount === 1, 'A2: 혼자 쓰는 계약 = 1');
  ok(by.A.totalCost === 10000000 && by.B.totalCost === 10000000, 'A3: 금액은 나누지 않는다(줄마다 계약 전체)');
  ok(p.q.filter(x => /GROUP BY sales_id/.test(x.s)).length === 1, 'A4: 공유 수 조회는 1회(N+1 금지)');

  p = pool([[/WITH own AS/, () => ({ rows: own })], [/GROUP BY sales_id/, () => { throw new Error('boom'); }]]);
  svc.__setPoolForTest(p);
  items = await svc.settlementSummaryForAdvertiser({ advertiserId: 'ADV' });
  ok(items.find(i => i.tabName === 'A').sharedTabCount === 2, 'A5: 조회 실패 → 목록 안에서 셈(throw 금지)');

  // ═══ B. 작업보드 정산 칸 ═══
  const linkRoute = [/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/, () => ({ rows: [{ salesId: 'SA1', contractNumber: 'C-1' }] })];
  p = pool([linkRoute, [/NOT \(l\.sheet_id = \$2 AND l\.tab_name = \$3\)/, () => ({ rows: [{ sheetId: 'S', tabName: 'B', label: '작업 B', total: 24 }] })]]);
  svc.__setPoolForTest(p);
  let out = await svc.settlementForTab({ sheetId: 'S', tabName: 'A', role: 'admin' });
  ok(Array.isArray(out.sharedTabs) && out.sharedTabs.length === 1 && out.sharedTabs[0].label === '작업 B', 'B1: 내부는 함께 쓰는 작업 이름을 받는다');
  ok(out.sharedTabCount === 25 && !('total' in out.sharedTabs[0]), 'B1b: 숫자는 잘리기 전 전체(자기 포함 25) — 목록 길이로 세지 않는다');

  p = pool([linkRoute]);
  svc.__setPoolForTest(p);
  out = await svc.settlementForTab({ sheetId: 'S', tabName: 'A', role: 'advertiser', advertiserId: 'ADV' });
  ok(out.sharedTabs === undefined, 'B2: 광고주에겐 싣지 않는다');
  ok(!p.q.some(x => /NOT \(l\.sheet_id/.test(x.s)), 'B3: 광고주 요청에선 다른 작업 조회 자체가 없다');

  p = pool([linkRoute, [/NOT \(l\.sheet_id/, () => { throw new Error('boom'); }]]);
  svc.__setPoolForTest(p);
  out = await svc.settlementForTab({ sheetId: 'S', tabName: 'A', role: 'admin' });
  ok(out.linked === true && out.sharedTabs === undefined, 'B4: 조회 실패 → 필드 미동봉(정산 칸은 그대로 뜬다)');

  // ═══ C. 업체 화면 요약(광고주 렌즈) ═══
  p = pool([[/WITH own AS/, () => ({ rows: own })], [/GROUP BY sales_id/, () => ({ rows: [{ salesId: 'SA1', n: 3 }, { salesId: 'SB2', n: 1 }] })]]);
  svc.__setPoolForTest(p);
  const sum = await svc.advertiserWorkSummary({ advertiserId: 'ADV' });
  const sb = Object.fromEntries(sum.items.map(i => [i.tabName, i]));
  ok(sb.A.settlement.sharedTabCount === 2, 'C1: 광고주 렌즈는 보이는 작업 안에서만 센다(전체 3 아님)');
  ok(sb.A.settlement.shareGroup && sb.A.settlement.shareGroup === sb.B.settlement.shareGroup, 'C2: 같은 계약 = 같은 묶음 번호');
  ok(sb.C.settlement.shareGroup === null && sb.C.settlement.sharedTabCount === 1, 'C3: 혼자 쓰는 계약은 묶음 없음');
  ok(!('salesId' in sb.A.settlement) && typeof sb.A.settlement.shareGroup === 'number', 'C4: 인트라넷 계약 ID 는 여전히 폐기(불투명 번호만)');

  global.fetch = savedFetch;

  // ═══ D. 화면 ═══
  const wd = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
  const cut = (a, b) => { const i = wd.indexOf(a); const j = wd.indexOf(b, i); assert.ok(i >= 0 && j > i, `추출 실패: ${a}`); return wd.slice(i, j); };
  const box = { esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.createContext(box);
  vm.runInContext(cut('function _shareBadge(', 'function _awRowHtml(').replace(/function _awRowHtml[\s\S]*$/, ''), box);
  ok(/외 22개/.test(box._shareBadge(25, ['a', 'b'])), 'D2b: 이름이 잘렸으면 나머지 개수를 말한다');
  ok(box._shareBadge(1) === '' && box._shareBadge(null) === '' && box._shareBadge(undefined) === '', 'D1: 2 미만·모름은 아무것도 안 그린다');
  const bdg = box._shareBadge(3, ['작업 "B"', '<C>']);
  ok(/🔗 작업 3개 공유/.test(bdg) && /계약 전체 금액/.test(bdg), 'D2: 배지 문구 + 계약 전체 금액이라는 설명');
  ok(!/<C>|"B"/.test(bdg) && /&lt;C&gt;/.test(bdg), 'D3: 작업 이름은 escape(시트발 문자열)');
  const uq = box._awUniqContracts([
    { settlement: { shareGroup: 1 } }, { settlement: { shareGroup: 1 } }, { settlement: { shareGroup: null } }, { settlement: { shareGroup: 2 } }, { settlement: { shareGroup: 2 } },
  ]);
  ok(uq.length === 3, 'D4: 합계용 목록은 같은 계약을 한 번만 남긴다');

  const dash = cut('function _renderAdvDash(){', '// ④ 확인 필요');
  ok(/const contracts=_awUniqContracts\(linked\)/.test(dash) && /contracts\.forEach\(it=>\{ const \{s,tc,pa,rest\}=_awSetl\(it\)/.test(dash), 'D5: 대시보드 금액 합계는 계약당 한 번');
  ok(!/linked\.forEach\(/.test(dash), 'D6: 작업 줄 단위 합산(linked.forEach) 부활 금지');
  const todo = cut('// ④ 확인 필요', '// ⑤ 최근 작업');
  ok(/contracts\.map\(it=>\(\{it/.test(todo) && /contracts\.filter\(it=>\{ const \{s\}=_awSetl/.test(todo), 'D7: [확인 필요] 잔금·계산서 항목도 계약당 한 번');
  ok(/const tc=s&&s\.totalCost!=null\?\+s\.totalCost:null/.test(cut('function _awSetl(', 'function _shareBadge(')), 'D8: 줄마다의 표시값(_awSetl)은 그대로(금액을 나누지 않는다)');
  ok(/\$\{_shareBadge\(st\.sharedTabCount\)\}/.test(wd), 'D9: 업체관리 입금액/총비용 칸에 배지');
  ok(/\$\{s\?_shareBadge\(s\.sharedTabCount\):''\}/.test(wd), 'D10: 업체 화면 작업 목록 줄에 배지');
  ok(/d\.sharedTabs\.length\?`<span class="tp3share">\$\{_shareBadge\(d\.sharedTabCount\|\|d\.sharedTabs\.length\+1/.test(wd), 'D11: 작업보드 정산 칸에 배지(자기 포함 +1)');
  ok((wd.match(/🔗 작업 \$\{n\}개 공유/g) || []).length === 1, 'D12: 배지 문구는 한 곳(사본 금지)');
  ok(/\.owntab \.bb\.shr\{display:flex/.test(wd), 'D13: 업체관리 칸은 줄을 내려 배지를 보인다(ocol 의 overflow:hidden 에 잘리지 않게)');

  console.log(`✅ contractSharedBadge: ${pass} cases passed`);
  process.exit(0);
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
