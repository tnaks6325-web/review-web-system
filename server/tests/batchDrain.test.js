/**
 * batchDrain 단위 테스트 — 배치 버스트 경로의 위험 로직 검증(레드-블루-심판 R-B3/R-B9).
 *   순수/주입가능 부분만 검증(락·claim·markWritten은 테스트시트 E2E에서).
 * 실행: node tests/batchDrain.test.js
 */
const assert = require('assert');
const { _isQuota, _readGuardWindow } = require('../src/services/syncQueue.service');

async function run() {
  // ── R-B9: quota 에러 판정 ──
  assert.equal(_isQuota({ code: 429 }), true, '429 code → quota');
  assert.equal(_isQuota({ message: 'Quota exceeded for quota metric' }), true, 'Quota 문자열');
  assert.equal(_isQuota({ message: 'rate limit exceeded' }), true, 'rate limit');
  assert.equal(_isQuota({ message: 'RESOURCE_EXHAUSTED' }), true, 'RESOURCE_EXHAUSTED');
  assert.equal(_isQuota({ response: { status: 429 } }), true, 'response.status 429');
  assert.equal(_isQuota({ message: 'target row already filled' }), false, '일반 에러 → not quota');
  assert.equal(_isQuota(null), false, 'null → false');
  console.log('  R-B9 _isQuota 통과');

  // ── R-B3: 그리드밖 행은 [] 반환(빈칸 통과), 오프셋 매핑 정확 ──
  // 가드 대상 행 [165, 166, 268]. minCol=7, maxCol=9. 그리드는 165~167만 존재(268은 그리드밖).
  let capturedRange = null;
  const fakeReader = async (range /*, opts */) => {
    capturedRange = range;
    // minRow=165 기준 grid[0]=165행, grid[1]=166행, grid[2]=167행(요청 안 함)
    return [
      ['a165', 'b165', 'c165'],   // 165
      ['a166', '', 'c166'],       // 166 (가운데 빈칸)
      // 167 자리(off=2)도 있지만 우리가 요청한 행 아님
    ];
    // 268(off=103)은 grid에 없음 → undefined → [] 로 매핑되어야 함
  };
  const map = await _readGuardWindow('sheetX', '테스트탭', '123', [165, 166, 268], 7, 9, fakeReader);

  assert.equal(capturedRange, "'테스트탭'!H165:J268", '★ 사각형 range = minCol(7→H)..maxCol(9→J) × minRow..maxRow');
  assert.deepEqual(map.get(165), ['a165', 'b165', 'c165'], '165행 cells');
  assert.deepEqual(map.get(166), ['a166', '', 'c166'], '166행 cells(빈칸 보존)');
  assert.deepEqual(map.get(268), [], '★ 그리드밖 268행 → [](빈칸 통과=단건경로 시맨틱)');
  console.log('  R-B3 _readGuardWindow 오프셋/그리드밖 통과');

  // ── 빈 입력 방어 ──
  const empty = await _readGuardWindow('s', 't', '0', [], 0, 0, async () => []);
  assert.equal(empty.size, 0, '빈 rows → 빈 맵(읽기 호출 안 함)');
  console.log('  빈 입력 방어 통과');
}

run().then(() => console.log('batchDrain tests passed'))
  .catch(e => { console.error(e); process.exit(1); });
