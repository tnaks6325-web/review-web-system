/**
 * P3 마감자료 자동 생성(리뷰완료 증빙 스냅샷) 회귀가드.
 *   1. generateCloseout — 활성 명단 건수/제출건수 집계, 이력 INSERT(재생성 보존), 빈 명단 거부.
 *   2. latestCloseout — 최신 1건(스텝퍼 ① 소스). 정의됨 = settlementForTab closeoutAvailable 라이브.
 *   3. closeoutCsv — BOM·헤더·행. 광고주 렌즈 연락처 마스킹(끝4자리), 내부는 전체.
 *   4. Track A/시트 무접촉(campaign_participants 읽기 + trackb_tab_closeouts write 만).
 * 실행: node tests/trackBCloseout.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}
const roster = [
  { seq: 1, name: '김철수', recipient: '김철수', phone8: '12345678', round: '1', option: 'A', product: '샴푸', submitted: true, paid: true, submittedAt: '2026-07-28T10:00:00Z' },
  { seq: 2, name: '이영희', recipient: '이영희', phone8: '87654321', round: '1', option: 'B', product: '샴푸', submitted: false, paid: false, submittedAt: null },
];

async function run() {
  // ═══ 1. generateCloseout ═══
  let cap;
  let p = pool([
    [/FROM campaign_participants WHERE sheet_id=\$1 AND tab_name=\$2 AND active=TRUE/, () => ({ rows: roster })],
    [/INSERT INTO trackb_tab_closeouts/, (s, prm) => { cap = prm; return { rows: [{ id: 1, date: '2026-07-28', rowCount: prm[3], subCount: prm[4], createdBy: prm[5] }] }; }],
  ]); svc.__setPoolForTest(p);
  let r = await svc.generateCloseout({ sheetId: 'S1', tabName: 'T', by: 'kim' });
  assert.equal(r.ok, true); assert.equal(r.closeout.rowCount, 2, '1a: 활성 명단 2건');
  assert.equal(r.closeout.subCount, 1, '1b: 제출완료 1건');
  assert.ok(/INSERT INTO trackb_tab_closeouts/.test(p.q[1].s), '1c: 마감 원장 INSERT(이력 보존)');
  assert.ok(!p.q.some(x => /review_index|order_submissions|raw_sheet|UPDATE campaign_participants/.test(x.s)), '1d: Track A·시트 무접촉(읽기만)');

  // 빈 명단 거부
  p = pool([[/FROM campaign_participants WHERE/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.generateCloseout({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.ok, false, '1e: 빈 명단 거부'); assert.equal(r.code, 400);
  console.log('  1. generateCloseout — 건수/제출 집계·이력 INSERT·읽기만·빈명단 거부 ✓');

  // ═══ 2. latestCloseout (정의 존재 = closeoutAvailable 라이브) ═══
  assert.equal(typeof svc.latestCloseout, 'function', '2a: latestCloseout 정의됨');
  p = pool([[/FROM trackb_tab_closeouts WHERE sheet_id=\$1 AND tab_name=\$2 AND deleted_at IS NULL ORDER BY created_at DESC/, () => ({ rows: [{ id: 9, date: '2026-07-28', rowCount: 50, subCount: 50 }] })]]);
  svc.__setPoolForTest(p);
  r = await svc.latestCloseout({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.rowCount, 50, '2b: 최신 마감 반환');
  // settlementForTab 이 이제 closeoutAvailable=true (링크 없어도)
  p = pool([
    [/FROM trackb_settlement_links WHERE/, () => ({ rows: [] })],
    [/FROM trackb_tab_closeouts WHERE/, () => ({ rows: [{ id: 9, date: '2026-07-28', rowCount: 50, subCount: 50 }] })],
  ]); svc.__setPoolForTest(p);
  const s = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'master' });
  assert.equal(s.closeoutAvailable, true, '2c: P3 도착 → closeoutAvailable=true');
  assert.ok(s.closeout && s.closeout.rowCount === 50, '2d: 스텝퍼 ① 마감자료 병합');
  console.log('  2. latestCloseout — 최신 반환 + settlementForTab closeoutAvailable 라이브 ✓');

  // ═══ 3. closeoutCsv — BOM·헤더·마스킹 ═══
  p = pool([[/FROM campaign_participants WHERE/, () => ({ rows: roster })]]); svc.__setPoolForTest(p);
  let csv = await svc.closeoutCsv({ sheetId: 'S1', tabName: 'T', role: 'master' });
  assert.ok(csv.charCodeAt(0) === 0xFEFF, '3a: UTF-8 BOM');
  assert.ok(csv.includes('번호,참여자,연락처'), '3b: 헤더');
  assert.ok(csv.includes('12345678'), '3c: 내부는 연락처 전체');
  assert.ok(csv.includes('2026-07-28'), '3d: 제출일');
  csv = await svc.closeoutCsv({ sheetId: 'S1', tabName: 'T', role: 'advertiser' });
  assert.ok(csv.includes('****5678') && !csv.includes('12345678'), '3e: 광고주는 연락처 마스킹(끝4자리)');
  console.log('  3. closeoutCsv — BOM·헤더·제출일·광고주 마스킹 ✓');

  svc.__setPoolForTest(null);
  console.log('✅ trackBCloseout 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
