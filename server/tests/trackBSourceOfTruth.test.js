/**
 * Track B 진실원천(source_of_truth) 컨트롤 회귀가드 — 옵션 A cutover 스위치 P1.
 *   ★ 최우선 불변식(격리): source_of_truth 를 읽는 소비처는 trackB.service.js / trackB.routes.js 뿐.
 *     Track A 라이브 핫패스(검색·주문원장·리뷰인덱스빌드·행배정·큐워커·RAW미러)는 절대 미참조 →
 *     플립해도 Track A 동작 불변(P2 write-back 엔진이 생기기 전까지 inert)임을 fs 스캔으로 고정.
 *   + setSourceOfTruth 게이트(invalid_value·parity real=0 게이트·tab_not_found)·getSourceOfTruth 기본값.
 * 실행: node tests/trackBSourceOfTruth.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');

// source_of_truth 를 참조해도 되는 유일한 런타임 파일(=Track B 격리 소비처).
const ALLOWED = new Set(['services/trackB.service.js', 'routes/trackB.routes.js']);

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// 간이 query 목: 패턴별 rows/rowCount 반환.
function makePool(scn = {}) {
  const q = [];
  return {
    q,
    async query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push(s);
      if (/UPDATE tab_configs SET source_of_truth/.test(s)) return { rowCount: scn.updRowCount == null ? 1 : scn.updRowCount };
      if (/source_of_truth AS "sourceOfTruth" FROM tab_configs/.test(s)) return { rows: scn.sotRow ? [{ sourceOfTruth: scn.sotRow }] : [] };
      if (/FROM review_index/.test(s)) return { rows: scn.aRows || [] };
      if (/FROM campaign_participants/.test(s)) return { rows: scn.bRows || [] };
      // participant_edits · work_orders · advertiser_campaigns · order_submissions · raw_sheet_tabs(readiness) 등
      return { rows: [] };
    },
  };
}

async function run() {
  const SRC = path.join(__dirname, '..', 'src');

  // ═══ 1. 격리 불변식: Track A 핫패스는 source_of_truth 미참조 ═══
  const offenders = [];
  for (const file of walk(SRC, [])) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    if (/source_of_truth/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `격리 위반: Track A 파일이 source_of_truth 를 참조함(cutover 플립이 라이브에 새는 경로) → ${offenders.join(', ')}`);
  console.log('  1. 격리 불변식 — source_of_truth 소비처는 Track B 파일뿐(Track A 무접촉) ✓');

  // ═══ 2. setSourceOfTruth 게이트 ═══
  // 2a: 허용값 밖 → invalid_value (DB 미접근)
  svc.__setPoolForTest(makePool());
  let r = await svc.setSourceOfTruth({ sheetId: 'S1', tabName: 'T', value: 'garbage' });
  assert.equal(r.ok, false); assert.equal(r.error, 'invalid_value', '2a: 허용값 밖 거부');

  // 2b: 'sheet' 복귀는 parity 게이트 없이 즉시 반영(rowCount=1)
  let p = makePool({ updRowCount: 1 }); svc.__setPoolForTest(p);
  r = await svc.setSourceOfTruth({ sheetId: 'S1', tabName: 'T', value: 'sheet', by: 'master' });
  assert.equal(r.ok, true); assert.equal(r.sourceOfTruth, 'sheet', '2b: sheet 복귀 허용');
  assert.ok(p.q.some(s => /UPDATE tab_configs SET source_of_truth/.test(s)), '2b: UPDATE 실행');
  assert.ok(!p.q.some(s => /FROM review_index/.test(s)), '2b: sheet 복귀는 parity 미조회');

  // 2c: 없는 탭 → tab_not_found
  p = makePool({ updRowCount: 0 }); svc.__setPoolForTest(p);
  r = await svc.setSourceOfTruth({ sheetId: 'S1', tabName: '없음', value: 'sheet' });
  assert.equal(r.ok, false); assert.equal(r.error, 'tab_not_found', '2c: 없는 탭 거부');

  // 2d: 'db' 전환 — parity real=0(빈 A/B)면 허용 + UPDATE 실행
  p = makePool({ aRows: [], bRows: [], updRowCount: 1 }); svc.__setPoolForTest(p);
  r = await svc.setSourceOfTruth({ sheetId: 'S1', tabName: 'T', value: 'db', by: 'master' });
  assert.equal(r.ok, true); assert.equal(r.sourceOfTruth, 'db', '2d: real=0 → db 전환 허용');
  assert.ok(p.q.some(s => /FROM review_index/.test(s)), '2d: db 전환은 parity 게이트 조회함');
  console.log('  2. setSourceOfTruth — invalid_value·sheet복귀·tab_not_found·db게이트(real0 허용) ✓');

  // ═══ 3. getSourceOfTruth 기본값 ═══
  svc.__setPoolForTest(makePool({ sotRow: null }));
  assert.equal(await svc.getSourceOfTruth({ sheetId: 'S1', tabName: 'T' }), 'sheet', '3a: 행 없음 → 기본 sheet');
  svc.__setPoolForTest(makePool({ sotRow: 'db' }));
  assert.equal(await svc.getSourceOfTruth({ sheetId: 'S1', tabName: 'T' }), 'db', '3b: 저장값 db 반환');
  console.log('  3. getSourceOfTruth — 기본 sheet · 저장값 반환 ✓');

  console.log('✅ trackBSourceOfTruth 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
