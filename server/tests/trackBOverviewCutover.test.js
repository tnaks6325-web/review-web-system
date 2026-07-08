/**
 * Track B 관측 대시보드 — cutover 종합 판정 + write-back 건강 매핑 회귀가드.
 *   overview()가 완성 신호(카운트·소유·발주·원본)를 하나의 cutoverReady 판정으로 수렴하고,
 *   participant_edits 집계(editCount·held·blocked)를 write-back 건강으로 노출하는지 고정.
 * 실행: node tests/trackBOverviewCutover.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function poolReturning(rows) {
  return { async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM b LEFT JOIN raw_sheet_tabs/.test(s)) return { rows };
    return { rows: [] };
  } };
}

async function run() {
  // aTotal=bTotal 등 카운트 일치 + owned + woLinked + sheet → cutoverReady true
  const rows = [
    { sheetId: 'S1', tabName: 'A', tabGid: '1', bTotal: 10, bSub: 5, bPaid: 3, bLinked: 4, lastProjectedAt: null,
      spreadsheetTitle: '시트', aTotal: 10, aSub: 5, aPaid: 3, owned: true, woLinked: true, sourceOfTruth: 'sheet',
      editCount: 2, wbHeld: 0, wbBlocked: 0 },
    { sheetId: 'S1', tabName: 'B', tabGid: '2', bTotal: 10, bSub: 5, bPaid: 3, bLinked: 4, lastProjectedAt: null,
      spreadsheetTitle: '시트', aTotal: 10, aSub: 5, aPaid: 3, owned: false, woLinked: true, sourceOfTruth: 'sheet',
      editCount: 0, wbHeld: 0, wbBlocked: 0 },
    { sheetId: 'S1', tabName: 'C', tabGid: '3', bTotal: 9, bSub: 5, bPaid: 3, bLinked: 4, lastProjectedAt: null,
      spreadsheetTitle: '시트', aTotal: 10, aSub: 5, aPaid: 3, owned: true, woLinked: true, sourceOfTruth: 'sheet',
      editCount: 0, wbHeld: 0, wbBlocked: 0 },
    { sheetId: 'S1', tabName: 'D', tabGid: '4', bTotal: 10, bSub: 5, bPaid: 3, bLinked: 4, lastProjectedAt: null,
      spreadsheetTitle: '시트', aTotal: 10, aSub: 5, aPaid: 3, owned: true, woLinked: true, sourceOfTruth: 'db',
      editCount: 3, wbHeld: 1, wbBlocked: 2 },
  ];
  svc.__setPoolForTest(poolReturning(rows));
  const items = await svc.overview();
  const by = Object.fromEntries(items.map(x => [x.tabName, x]));

  assert.equal(by.A.cutoverReady, true, 'A: 카운트·소유·발주·시트원본 → cutover 준비');
  assert.equal(by.A.countMatch, true, 'A: countMatch');
  assert.deepEqual(by.A.writeback, { held: 0, blocked: 0 }, 'A: write-back 건강 매핑');
  assert.equal(by.A.editCount, 2, 'A: 편집수 노출');

  assert.equal(by.B.cutoverReady, false, 'B: 미소유 → 준비 아님');
  assert.equal(by.B.owned, false, 'B: owned false');

  assert.equal(by.C.cutoverReady, false, 'C: 카운트 불일치 → 준비 아님');
  assert.equal(by.C.countMatch, false, 'C: countMatch false');

  assert.equal(by.D.cutoverReady, false, 'D: 이미 db 전환됨 → 준비(대상) 아님');
  assert.equal(by.D.sourceOfTruth, 'db', 'D: 원본 db');
  assert.deepEqual(by.D.writeback, { held: 1, blocked: 2 }, 'D: write-back held/blocked 노출');

  svc.__setPoolForTest(null);
  console.log('  overview — cutoverReady(카운트·소유·발주·원본) + write-back 건강 ✓');
  console.log('✅ trackBOverviewCutover 테스트 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
