/**
 * participantMirror (Phase 2b) 회귀 가드.
 *   - enqueueTabMirror: 게이트 OFF 무동작 / eligible 없음 / eligible 있으면 enqueue(participant_mirror, ids).
 *   - _normSubmitCell/_wantMark: 제출문구 동치(핑퐁·오탐 흡수).
 *   - 계약: sheetsThrottle에 getThrottleStatus 존재 + requestsInLastMinute 키(‘getThrottleLoad’ 오타 재발 방지).
 * 실행: node tests/participantMirror.test.js
 */
const assert = require('assert');

// syncQueue.enqueue 목킹(require.cache) — enqueueTabMirror가 지연 require로 잡는다.
let _enq = [];
const sqPath = require.resolve('../src/services/syncQueue.service');
require.cache[sqPath] = { id: sqPath, filename: sqPath, loaded: true, exports: { enqueue: async (type, payload) => { _enq.push({ type, payload }); } } };

const mirror = require('../src/services/participantMirror.service');

function makePool(rows) { return { async query() { return { rows: rows || [] }; } }; }

async function run() {
  // ── _normSubmitCell 동치 ──
  assert.equal(mirror._normSubmitCell('완료'), 'O');
  assert.equal(mirror._normSubmitCell('O'), 'O');
  assert.equal(mirror._normSubmitCell('제출'), 'O');
  assert.equal(mirror._normSubmitCell(''), '');
  assert.equal(mirror._normSubmitCell('   '), '');
  assert.equal(mirror._normSubmitCell('X'), 'X');   // 사람 임의값은 보존(→ conflict 판정)
  assert.equal(mirror._wantMark(true), 'O');
  assert.equal(mirror._wantMark(false), '');
  console.log('  제출셀 정규화 동치 통과');

  // ── 게이트 OFF → 무동작(enqueue 0) ──
  delete process.env.PARTICIPANTS_SHEET_MIRROR;
  mirror.__setPoolForTest(makePool([{ id: 'a' }]));
  _enq = [];
  let r = await mirror.enqueueTabMirror({ sheetId: 's', tabName: 'T' });
  assert.equal(r.skipped, true); assert.equal(r.reason, 'gate_off');
  assert.equal(_enq.length, 0, '게이트 OFF면 enqueue 0');
  console.log('  게이트 OFF 무동작 통과');

  // ── 게이트 ON + eligible 없음 → enqueued 0 ──
  process.env.PARTICIPANTS_SHEET_MIRROR = '1';
  mirror.__setPoolForTest(makePool([]));
  _enq = [];
  r = await mirror.enqueueTabMirror({ sheetId: 's', tabName: 'T' });
  assert.equal(r.enqueued, 0); assert.equal(r.reason, 'no_eligible_rows');
  assert.equal(_enq.length, 0);
  console.log('  eligible 없음 통과');

  // ── 게이트 ON + eligible 2행 → enqueue(participant_mirror, ids 2) ──
  mirror.__setPoolForTest(makePool([{ id: 'id1' }, { id: 'id2' }]));
  _enq = [];
  r = await mirror.enqueueTabMirror({ sheetId: 's', tabName: 'T', by: 'master' });
  assert.equal(r.enqueued, 2);
  assert.equal(_enq.length, 1);
  assert.equal(_enq[0].type, 'participant_mirror');
  assert.deepEqual(_enq[0].payload.ids, ['id1', 'id2']);
  console.log('  eligible enqueue 통과');
  delete process.env.PARTICIPANTS_SHEET_MIRROR;
  mirror.__setPoolForTest(null);

  // ── 계약: getThrottleStatus 존재 + requestsInLastMinute (getThrottleLoad 오타 재발 방지) ──
  const thr = require('../src/utils/sheetsThrottle');
  assert.equal(typeof thr.getThrottleStatus, 'function', 'getThrottleStatus export 존재');
  assert.equal(typeof thr.getThrottleLoad, 'undefined', 'getThrottleLoad는 없음(오타 방지)');
  assert.ok('requestsInLastMinute' in thr.getThrottleStatus(), 'requestsInLastMinute 키 존재');
  console.log('  throttle API 계약 통과');
}
run().then(() => console.log('participantMirror tests passed')).catch(e => { console.error(e); process.exit(1); });
