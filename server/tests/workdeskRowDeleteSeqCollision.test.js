/* 작업보드 행 삭제 → 보충 슬롯 번호 충돌(23505) 회귀가드.
   (2026-08-24 실사고: 「8/3(쿠팡)위프_블랙 탈취제 800건」에서 우클릭 [행 삭제]가
   "duplicate key value violates unique constraint uq_participants_seq"로 매번 롤백됐다.)

   ★ 원인: 보충 슬롯의 다음 번호를 "지금 살아있는 줄"에서만 계산했다. `uq_participants_seq`는
     부분 인덱스가 아니라 소프트삭제·비활성 줄의 번호도 영구히 점유하므로, 예전에 [♻ 중복 정리]
     등으로 지운 더 큰 번호와 충돌할 수 있었다(그 INSERT엔 ON CONFLICT 도 없어 예외가 그대로
     올라와 트랜잭션 전체가 롤백됐다).
   ★ 수정: `appendSlot`(주문 이어붙이기)과 같은 계산 — 표 전체(소프트삭제·비활성 포함)에서
     MAX(seq)+1 을 구하고 `ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING`으로 받아, 0행이면
     (그 사이 다른 쓰기가 그 번호를 먼저 차지했다는 뜻) 재시도한다 — 예외를 던지지 않으므로
     SAVEPOINT 없이도 트랜잭션을 오염시키지 않는다.

   이 파일은 그 회복 동작을 스텁 pool 로 실제 실행해 고정한다:
     ① 첫 시도가 충돌(0행)해도 재시도로 회복해 행 삭제가 정상 완료된다
     ② 충돌이 계속돼도(극단적 경합) 무한루프·미처리 예외 없이 깨끗하게 실패로 응답한다 */
const assert = require('assert');

const svc = require('../src/services/trackB.service');
const cancelPath = require.resolve('../src/services/orderCancellation.service');
const renumberPath = require.resolve('../src/services/rowNumbering.service');

function stubModule(resolvedPath, exportsObj) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObj };
}
function restoreModule(resolvedPath) { delete require.cache[resolvedPath]; }

// 이 시나리오는 "살아 있는 구매양식이 없는 행"으로 단순화한다(주문 취소 경로 자체는
// workdeskRowDeleteOrderCancel.test.js 가 따로 고정한다) — 여기서 볼 것은 보충 슬롯 재시도뿐이다.
function makeStubPool({ insertAnswers }) {
  const log = [];
  let insertCalls = 0;
  const answer = (sql, params) => {
    const norm = String(sql).replace(/\s+/g, ' ').trim();
    log.push({ sql: norm, params });
    const q = norm;
    if (q.includes('FROM campaign_participants cp') && q.includes('JOIN order_submissions')) {
      return { rows: [] };   // 살아 있는 구매양식 없음 → 취소 경로 미진입
    }
    if (q.includes('SELECT id, seq, phone8, row_json, order_submission_id')) {
      return { rows: [{ id: 'row-1', seq: 728, phone8: '12345678', row_json: { '구매일자': '8/24 (월)' }, order_submission_id: null }] };
    }
    if (q.includes('COALESCE(sheetless,FALSE) AS sheetless')) return { rows: [{ sheetless: true }] };
    if (q.includes('SELECT rc.id AS campaign_id')) return { rows: [] };   // 연결 공고 없음(campaignScope='none')
    if (q.includes('SELECT seq, tab_gid, row_json')) {
      return { rows: [{ seq: 728, tab_gid: '99', row_json: { '구매일자': '8/24 (월)' } }] };
    }
    if (q.includes('INSERT INTO workdesk_participant_deletions')) return { rowCount: 1, rows: [] };
    if (q.includes('DELETE FROM campaign_participants')) return { rowCount: 1, rows: [] };
    if (q.includes('DELETE FROM participation_links')) return { rowCount: 1, rows: [] };
    if (q.startsWith('INSERT INTO campaign_participants')) {
      insertCalls += 1;
      return insertAnswers(insertCalls, params);
    }
    return { rowCount: 0, rows: [] };   // BEGIN/COMMIT/ROLLBACK 등
  };
  const client = { query: async (sql, params) => answer(sql, params), release() {} };
  return { log, client, pool: { query: async (sql, params) => answer(sql, params), connect: async () => client }, insertCallCount: () => insertCalls };
}

(async () => {
  stubModule(renumberPath, { renumberTabInTx: async () => ({ ok: true, changed: 0 }) });
  stubModule(cancelPath, { cancelOrderSubmission: async () => { throw new Error('이 시나리오는 취소 경로에 도달하면 안 됩니다'); } });

  // ① 첫 시도가 번호 충돌(ON CONFLICT DO NOTHING → 0행)해도 재시도로 회복한다.
  {
    const { pool, insertCallCount } = makeStubPool({
      insertAnswers: (n) => (n === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 'row-new', seq: 801 }] }),
    });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => ({ ok: true }));
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' });
    assert.strictEqual(out.ok, true, `첫 시도 충돌은 재시도로 회복돼야 합니다: ${JSON.stringify(out)}`);
    assert.strictEqual(out.replenished, 1, '보충 슬롯은 결국 만들어져야 합니다(총원 유지)');
    assert.strictEqual(out.replacementSeq, 801, '재시도에서 성공한 슬롯의 번호를 그대로 돌려줘야 합니다');
    assert.strictEqual(insertCallCount(), 2, '충돌 1회 → 재시도 1회 = 총 2번 시도해야 합니다');
  }

  // ② 충돌이 상한(5회)까지 계속되면 조용히 넘어가지 않고 명시적으로 실패시킨다
  //    (보충 없이 삭제만 반영되는 상태 = 총 모집인원 축소를 만들지 않는다).
  {
    const { pool, insertCallCount } = makeStubPool({
      insertAnswers: () => ({ rowCount: 0, rows: [] }),   // 항상 충돌(극단적 동시경합 시뮬레이션)
    });
    svc.__setPoolForTest(pool);
    svc.__setLedgerRebuildForTest(async () => ({ ok: true }));
    let threw = false;
    let out;
    try { out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-1', by: '망고', actorRole: 'admin' }); }
    catch (e) { threw = true; out = { error: e && e.message }; }
    assert.strictEqual(threw, false, '재시도 소진도 500 마스킹/미처리 예외로 흘리지 않고 응답으로 돌려줘야 합니다');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'replacement_slot_failed', '원인 코드를 그대로 알려야 합니다(운영자가 재시도할 수 있게)');
    assert.strictEqual(insertCallCount(), 5, '무한루프가 아니라 상한(5회)에서 멈춰야 합니다');
  }

  restoreModule(cancelPath);
  restoreModule(renumberPath);
  svc.__setPoolForTest(null);
  svc.__setLedgerRebuildForTest(null);
  console.log('workdesk row delete seq-collision retry contract passed');
  process.exit(0);
})();
