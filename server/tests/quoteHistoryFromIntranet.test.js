/**
 * 견적서 팝업 버전 탭 = 인트라넷 견적서 이력 회귀가드 (사용자 확정 2026-10-14 · 광고주 화면 포함 통일).
 *   인트라넷이 견적서를 고칠 때마다 직전 내용을 보관한다(GET /api/quotes/:id/versions?full=1, 서버 키 읽기 전용).
 *   A. 이력이 있으면 버전 탭 = [첫 수정 전 리뷰웹 기록] + [인트라넷 이력] + [지금 견적서], 같은 내용 연속은 한 번
 *   B. 이력 0건·조회 실패·구버전 인트라넷 = 종전 리뷰웹 스냅샷 그대로
 *   C. 광고주 화면도 같은 버전 탭 — 고친 사람 이름·내부 메모는 실리지 않는다
 * 실행: node tests/quoteHistoryFromIntranet.test.js
 */
const assert = require('assert');
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

const items = n => JSON.stringify([{ name: '리뷰 관리', unit_price: 33333, count: n, amount: 33333 * n, tax: Math.floor(3333.3 * n) }]);
const LIVE = { id: 'q1', quote_number: 'Q-1', quote_type: 'online_marketing', status: 'accepted', quote_date: '2026-10-01',
  created_at: '2026-10-01 01:00:00', updated_at: '2026-10-14 10:12:00', receiver: '가상상사', items: items(7), total_amount: 256664, memo: '내부 메모 — 광고주 비공개' };
const HISTORY = [
  { id: 'v2', version: 2, replaced_at: Date.parse('2026-10-14T10:12:00Z'), replaced_by_name: '가상관리자',
    snapshot: { ...LIVE, items: items(5), total_amount: 183331, updated_at: '2026-10-14 10:11:00' } },
  { id: 'v1', version: 1, replaced_at: Date.parse('2026-10-14T10:11:00Z'), replaced_by_name: '가상관리자',
    snapshot: { ...LIVE, status: 'sent', items: items(3), total_amount: 109998, updated_at: '2026-10-01 01:00:00' } },
];

let mode = 'history';
const savedFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (/\/api\/tables\/quotes\?where=sales_id=S1/.test(u)) return { ok: true, json: async () => ({ data: [LIVE] }) };
  const m = u.match(/\/api\/quotes\/(\w+)\/versions\?full=1/);
  if (m) {
    if (mode === 'down') throw new Error('down');
    if (mode === 'old-intranet') return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    if (mode === 'empty') return { ok: true, json: async () => ({ quote: {}, versions: [] }) };
    return { ok: true, json: async () => ({ quote: {}, versions: m[1] === 'q1' ? HISTORY : [] }) };
  }
  if (/brand-assets/.test(u)) return { ok: true, json: async () => ({ data: null }) };
  return { ok: true, json: async () => ({ data: [] }) };
};

// 리뷰웹이 예전에 남긴 기록: 기능 전(10/1) 1건 + 첫 수정 뒤(10/14 11시)에 열어 본 1건
const LEGACY = [
  { version: 1, payload: { quoteNumber: 'Q-1', status: 'draft', totalAmount: 99999 }, capturedAt: '2026-09-30T00:00:00.000Z' },
  { version: 2, payload: { quoteNumber: 'Q-1', status: 'accepted', totalAmount: 256664 }, capturedAt: '2026-10-14T11:00:00.000Z' },
];
const docPool = () => pool([
  [/FROM trackb_settlement_links WHERE sheet_id=\$1 AND tab_name=\$2/, () => ({ rows: [{ salesId: 'S1', contractNumber: 'C' }] })],
  [/SELECT version, content_hash FROM trackb_quote_snapshots/, () => ({ rows: [{ version: 2, content_hash: 'x' }] })],
  [/INSERT INTO trackb_quote_snapshots/, () => ({ rows: [] })],
  [/SELECT version, payload, captured_at/, () => ({ rows: LEGACY })],
  [/advertiser_settlement|settlement_visible|FROM advertisers|FROM trackb_brand/, () => ({ rows: [{ visible: true, settlement_visible: true }] })],
]);

async function run() {
  // ═══ A ═══
  svc.__setPoolForTest(docPool());
  let doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S1', role: 'admin' });
  let vs = doc.docs[0].versions;
  ok(vs.length === 4, `A1: 기능 전 리뷰웹 기록 1 + 인트라넷 이력 2 + 지금 1 = 4 (실제 ${vs.length})`);
  ok(vs.map(v => v.payload.totalAmount).join() === '99999,109998,183331,256664', 'A2: 오래된 순 — 첫 수정 뒤에 리뷰웹이 찍은 기록은 인트라넷 이력과 겹치므로 빠진다');
  ok(vs.map(v => v.version).join() === '1,2,3,4', 'A3: 번호는 다시 매긴다');
  ok(vs[1].capturedAt === '2026-10-01T01:00:00Z' && vs[3].capturedAt === '2026-10-14T10:12:00Z', 'A4: 인트라넷 저장 시각(UTC) → ISO');
  ok(vs[1].payload.status === 'sent' && vs[3].payload.status === 'accepted', 'A5: 각 버전은 그 시점 상태로 라벨(초안·발송·최종)');
  ok(doc.versions === doc.docs[0].versions, 'A6: versions = 첫 장(구버전 화면 호환) 유지');

  // ═══ C ═══
  ok(vs.every(v => !('memo' in v.payload) && !JSON.stringify(v.payload).includes('내부 메모')), 'C1: 내부 메모는 어떤 버전에도 실리지 않는다');
  ok(vs.every(v => !JSON.stringify(v).includes('가상관리자')), 'C2: 고친 사람 이름은 실리지 않는다');

  // ═══ D. 유효기간·담당자만 고친 저장도 지금 견적서가 마지막 탭(코덱스 리뷰 P1) ═══
  const savedLive = { ...LIVE };
  HISTORY.unshift({ id: 'v3', version: 3, replaced_at: Date.parse('2026-10-14T10:13:00Z'), replaced_by_name: '가상관리자',
    snapshot: { ...LIVE } });
  LIVE.valid_period = '견적일로부터 30일'; LIVE.updated_at = '2026-10-14 10:13:00';
  svc.__setPoolForTest(docPool());
  doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S1', role: 'admin' });
  vs = doc.docs[0].versions;
  ok(vs[vs.length - 1].payload.validPeriod === '견적일로부터 30일', 'D1: 마지막 탭 = 지금 견적서(유효기간만 바뀌어도 옛 값이 최신처럼 보이지 않는다)');
  ok(vs.length === 5 && vs[vs.length - 2].payload.validPeriod !== '견적일로부터 30일', 'D2: 유효기간만 바뀐 버전도 따로 남는다');
  HISTORY.shift(); Object.assign(LIVE, savedLive);

  // ═══ B ═══
  for (const m of ['empty', 'down', 'old-intranet']) {
    mode = m;
    svc.__setPoolForTest(docPool());
    doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S1', role: 'admin' });
    vs = doc.docs[0].versions;
    ok(vs.length === 2 && vs[0].payload.totalAmount === 99999 && vs[1].payload.totalAmount === 256664, `B(${m}): 종전 리뷰웹 스냅샷 그대로`);
    ok(doc.proxyDown === false, `B(${m}): 이력 조회 실패를 인트라넷 장애로 표시하지 않는다(견적서 본문은 받았다)`);
  }

  // ═══ E. 여러 장이면 이력 요청을 함께 보낸다(코덱스 리뷰 P2) ═══
  mode = 'history';
  const many = [0, 1, 2, 3].map(n => ({ ...LIVE, id: `m${n}`, quote_number: `Q-M${n}`, quote_date: `2026-10-0${n + 1}` }));
  let inFlight = 0, peak = 0;
  const prevFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (/\/api\/tables\/quotes\?where=sales_id=S1/.test(u)) return { ok: true, json: async () => ({ data: many }) };
    if (/\/versions\?full=1/.test(u)) {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 50)); inFlight--;
      return { ok: true, json: async () => ({ versions: [] }) };
    }
    return prevFetch(url);
  };
  svc.__setPoolForTest(docPool());
  doc = await svc.quoteDocForTab({ sheetId: 'X', tabName: 'S1', role: 'admin' });
  ok(doc.docs.length === 4 && peak === 4, `E1: 4장의 이력 요청이 동시에 나간다(동시 ${peak})`);
  global.fetch = prevFetch;

  global.fetch = savedFetch;
  console.log(`✅ quoteHistoryFromIntranet: ${pass} cases passed`);
  process.exit(0);
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
