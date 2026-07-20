/**
 * Track B 작업목록 즐겨찾기(계정별 개인화·영속) 회귀가드.
 *   getWorkdeskFavorites: 무행→[] · 행존재→배열 · 빈owner→[](DB무접근) · 비배열favorites→[].
 *   setWorkdeskFavorites: upsert(ON CONFLICT) · 중복제거·비문자열/빈/초장 필터 · 1000 상한 · 빈owner→no_owner(DB무접근).
 * 실행: node tests/trackBWorkdeskFavorites.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function makePool(scn = {}) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    q.push({ s, params });
    if (/SELECT favorites FROM trackb_workdesk_favorites/.test(s)) return { rows: scn.favRow !== undefined ? [{ favorites: scn.favRow }] : [] };
    if (/INSERT INTO trackb_workdesk_favorites/.test(s)) return { rowCount: 1 };
    return { rows: [] };
  } };
}

async function run() {
  // ── get ──
  svc.__setPoolForTest(makePool({}));                    // 무행
  assert.deepEqual(await svc.getWorkdeskFavorites('kim'), [], 'no row → []');
  svc.__setPoolForTest(makePool({ favRow: ['a', 'b'] }));
  assert.deepEqual(await svc.getWorkdeskFavorites('kim'), ['a', 'b'], 'row → array');
  let p = makePool({ favRow: ['x'] }); svc.__setPoolForTest(p);
  assert.deepEqual(await svc.getWorkdeskFavorites('  '), [], 'empty owner → []');
  assert.equal(p.q.length, 0, 'empty owner = no DB access');
  svc.__setPoolForTest(makePool({ favRow: 'oops' }));
  assert.deepEqual(await svc.getWorkdeskFavorites('kim'), [], 'non-array favorites → []');
  console.log('  get ✓');

  // ── set: 정제(중복/비문자열/빈/초장) + upsert ──
  p = makePool(); svc.__setPoolForTest(p);
  const out = await svc.setWorkdeskFavorites('kim', ['a', 'a', 'b', 123, '', 'x'.repeat(400), 'c', null]);
  assert.equal(out.ok, true); assert.equal(out.count, 3, 'dedup+filter → a,b,c');
  const ins = p.q.find(x => /INSERT INTO trackb_workdesk_favorites/.test(x.s));
  assert.ok(ins, 'INSERT 호출');
  assert.ok(/ON CONFLICT \(owner_key\) DO UPDATE/.test(ins.s), 'upsert(ON CONFLICT)');
  assert.deepEqual(JSON.parse(ins.params[1]), ['a', 'b', 'c'], '저장 배열 정제됨');

  // ── set: 1000 상한 ──
  p = makePool(); svc.__setPoolForTest(p);
  const out2 = await svc.setWorkdeskFavorites('kim', Array.from({ length: 1500 }, (_, i) => 'k' + i));
  assert.equal(out2.count, 1000, '1000 상한');

  // ── set: 빈 owner → no_owner(DB 무접근) ──
  p = makePool(); svc.__setPoolForTest(p);
  const out3 = await svc.setWorkdeskFavorites('', ['a']);
  assert.equal(out3.ok, false); assert.equal(out3.error, 'no_owner');
  assert.equal(p.q.length, 0, 'no_owner = no DB access');

  // ── set: 비배열 → [] 저장 ──
  p = makePool(); svc.__setPoolForTest(p);
  const out4 = await svc.setWorkdeskFavorites('kim', 'notarray');
  assert.equal(out4.count, 0, '비배열 → 0');
  console.log('  set ✓');

  svc.__setPoolForTest(null);
  console.log('ALL TRACKB WORKDESK FAVORITES TESTS PASSED ✓');
}
run().catch(e => { console.error(e); process.exit(1); });
