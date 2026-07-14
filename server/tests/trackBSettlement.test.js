/**
 * P2 정산 파이프라인(탭↔인트라넷 계약/견적 링크 + 프록시 스텝퍼) 회귀가드.
 *   1. link/unlink 는 trackb_settlement_links 만 write(인트라넷은 GET 프록시만).
 *   2. settlementForTab 역할 렌즈(Q4-c): 광고주 visible=FALSE → {hidden:true}(금액·상태 미포함),
 *      visible=TRUE(기본) → 금액 포함. 내부는 토글 무관.
 *   3. 프록시 fail-soft: 인트라넷 다운 시 링크 라벨(contract_number 캐시)만·proxyDown 신호.
 *   4. 링크된 sales 단건만 프록시(그 탭 링크 계약만 — 타 업체 계약 URL은 링크에서 파생).
 * 실행: node tests/trackBSettlement.test.js
 */
process.env.INTRANET_API_BASE = 'https://intranet.test';
const assert = require('assert');
const svc = require('../src/services/trackB.service');

// fetch 목: 경로별 응답. 호출 URL 캡처.
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    for (const [re, resp] of routes) if (re.test(String(url))) {
      if (resp === 'throw') throw new Error('intranet down');
      return { ok: true, status: 200, json: async () => resp };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}
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

  // ═══ 1. linkSettlement — trackb_settlement_links 만 write, sales 프록시는 GET ═══
  let calls = stubFetch([[/\/api\/tables\/sales\/S99/, { data: { contract_number: 'C-20260101-001' } }]]);
  let p = pool([
    [/UPDATE trackb_settlement_links SET deleted_at/, () => ({ rowCount: 0 })],
    [/INSERT INTO trackb_settlement_links/, () => ({ rows: [] })],
  ]); svc.__setPoolForTest(p);
  let r = await svc.linkSettlement({ sheetId: 'S1', tabName: 'T', salesId: 'S99', by: 'kim' });
  assert.equal(r.ok, true); assert.equal(r.contractNumber, 'C-20260101-001', '1a: 링크 시 C-번호 캐시');
  assert.ok(p.q.some(x => /INSERT INTO trackb_settlement_links/.test(x.s)), '1b: 링크 테이블 INSERT');
  assert.ok(!p.q.some(x => /work_orders|order_submissions|review_index/.test(x.s)), '1c: Track A 테이블 무접촉');
  assert.ok(calls.every(u => /\/api\/tables\/sales\//.test(u)), '1d: 인트라넷은 sales GET만(쓰기 없음)');

  // unlink
  p = pool([[/UPDATE trackb_settlement_links SET deleted_at/, () => ({ rowCount: 1 })]]); svc.__setPoolForTest(p);
  r = await svc.unlinkSettlement({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.removed, 1, '1e: unlink 소프트삭제');
  console.log('  1. link/unlink — trackb_settlement_links 만 write·인트라넷 GET·Track A 무접촉 ✓');

  // ═══ 2. settlementForTab 역할 렌즈(Q4-c) ═══
  const linkRow = { rows: [{ salesId: 'S99', quoteId: null, contractNumber: 'C-20260101-001', linkedBy: 'kim' }] };
  const salesResp = { data: { id: 'S99', contract_number: 'C-20260101-001', advertiser_name: '어니스트캄', product_name: '샴푸', amount: 5000000, payment_status: 'paid', invoice_status: 'issued', payment_date: '2026-07-15', invoice_date: '2026-07-31' } };

  // 2a: 내부(master) → 금액 포함 전체
  stubFetch([[/\/api\/tables\/sales\/S99/, salesResp]]);
  p = pool([[/FROM trackb_settlement_links WHERE/, () => linkRow]]); svc.__setPoolForTest(p);
  r = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'master' });
  assert.equal(r.linked, true); assert.equal(r.amount, 5000000, '2a: 내부 금액 노출');
  assert.equal(r.payment.status, 'paid', '2a: 입금 상태'); assert.equal(r.invoice.status, 'issued', '2a: 계산서 상태');
  assert.ok(!r.hidden, '2a: 내부 hidden 아님');

  // 2b: 광고주 + visible=TRUE(기본, prefs 행 없음) → 금액 포함
  stubFetch([[/\/api\/tables\/sales\/S99/, salesResp]]);
  p = pool([
    [/SELECT settlement_visible FROM trackb_advertiser_prefs/, () => ({ rows: [] })],   // 행 없음 = 기본 노출
    [/FROM trackb_settlement_links WHERE/, () => linkRow],
  ]); svc.__setPoolForTest(p);
  r = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1' });
  assert.equal(r.hidden, undefined, '2b: 기본 노출 → hidden 아님'); assert.equal(r.amount, 5000000, '2b: 광고주 금액 노출(Q4-c)');

  // 2c: 광고주 + visible=FALSE → hidden(금액·상태 미포함)
  const noFetch = stubFetch([]);   // 프록시 호출 자체가 없어야 함(hidden 조기 반환)
  p = pool([
    [/SELECT settlement_visible FROM trackb_advertiser_prefs/, () => ({ rows: [{ settlement_visible: false }] })],
    [/FROM trackb_settlement_links WHERE/, () => linkRow],
  ]); svc.__setPoolForTest(p);
  r = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1' });
  assert.equal(r.hidden, true, '2c: visible=FALSE → hidden');
  assert.equal(r.amount, undefined, '2c: 금액 미포함'); assert.equal(r.payment, undefined, '2c: 상태 미포함');
  assert.ok(!noFetch.some(u => /sales/.test(u)), '2c: hidden 시 인트라넷 프록시 미호출(계약 도달 없음)');
  console.log('  2. settlementForTab — 역할 렌즈(내부 전체·광고주 기본노출·토글 OFF hidden) ✓');

  // ═══ 3. 프록시 fail-soft ═══
  stubFetch([[/\/api\/tables\/sales\/S99/, 'throw']]);
  p = pool([[/FROM trackb_settlement_links WHERE/, () => linkRow]]); svc.__setPoolForTest(p);
  r = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'master' });
  assert.equal(r.linked, true, '3a: 링크는 유지'); assert.equal(r.contractNumber, 'C-20260101-001', '3b: 캐시 라벨 유지');
  assert.equal(r.proxyDown, true, '3c: proxyDown 신호'); assert.equal(r.amount, null, '3d: 프록시 실패 시 금액 null');
  console.log('  3. 프록시 fail-soft — 링크 라벨 유지·proxyDown ✓');

  // ═══ 4. setSettlementVisible upsert ═══
  p = pool([[/INSERT INTO trackb_advertiser_prefs/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.setSettlementVisible({ advertiserId: 'adv_1', visible: false, by: 'root' });
  assert.equal(r.ok, true); assert.equal(r.visible, false, '4a: 토글 저장');
  assert.ok(/ON CONFLICT \(advertiser_id\) DO UPDATE/.test(p.q[0].s), '4b: upsert');
  r = await svc.setSettlementVisible({ visible: true });
  assert.equal(r.ok, false, '4c: advertiserId 없으면 거부');
  console.log('  4. setSettlementVisible — upsert·검증 ✓');

  svc.__setPoolForTest(null); global.fetch = savedFetch;
  console.log('✅ trackBSettlement 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
