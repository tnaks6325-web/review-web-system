/**
 * reverseSyncAuto 단위 테스트 — 무인 자동적용(constrained auto-apply) 오케스트레이션 회귀 가드.
 *   방어 검증: 안전필드 화이트리스트 · apply시점 라이브 재검증(identity+cell) · 쿨다운 · 롤백값 기록.
 * 실행: node tests/reverseSyncAuto.test.js
 */
const assert = require('assert');

// ── 의존성 모킹(require.cache) — orderLedger가 함수 내부에서 inline require 하는 모듈들. ──
function mockModule(relId, exportsObj) {
  const resolved = require.resolve(relId);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let _rectGrid = [];                          // 사각형 라이브 읽기 결과(재검증용)
mockModule('../src/services/sheets.service', {
  readSheet: async (sheetId, range) => (/A1:ZZ/.test(range) ? [['헤더']] : _rectGrid),
  invalidateSheetMeta: () => {},
});
mockModule('../src/utils/sheetsThrottle', {
  throttledCall: async (fn) => fn(),
  getThrottleStatus: () => ({ requestsInLastMinute: 0, limit: 45 }),
});
mockModule('../src/utils/jobLock', {
  withJobLock: async (name, fn) => fn(),      // 락 항상 획득
  _lockKeys: () => [0, 0],
});
let _enqueues = [];
mockModule('../src/services/syncQueue.service', {
  enqueue: async (type, payload) => { _enqueues.push({ type, payload }); },
});
// 라이브 헤더 재감지 → 고정 헤더(orderer,user_id,recipient,phone,address,memo,date_str). _liveHeaders로 가변.
let _liveHeaders = ['주문자', '아이디', '수취인', '연락처', '주소', '비고', '일자'];
mockModule('../src/utils/sheetHeader', {
  detectSheetHeader: () => ({ headers: _liveHeaders }),
  normalizeCells: (x) => x,
});

const ledger = require('../src/services/orderLedger.service');

const HEADERS = ['주문자', '아이디', '수취인', '연락처', '주소', '비고', '일자'];

function makePool(scenario) {
  const calls = { updates: [], applied: [], dismissed: [] };
  return {
    calls,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ');
      // loadRawTabContext: raw_sheet_tabs 메타(detected_headers 채워 2차쿼리 스킵).
      if (s.includes('FROM raw_sheet_tabs')) return { rows: [{
        sheet_id: 's1', tab_gid: '9', tab_name: 'T', headers: HEADERS,
        detected_headers: HEADERS, header_row_index: 1, data_start_row: 2, _dup: '1' }] };
      if (s.includes('FROM raw_sheet_rows')) return { rows: [] };
      if (s.includes('FROM reverse_sync_proposals p JOIN order_submissions o')) return { rows: scenario.candidates };
      if (s.includes('SELECT orderer, user_id, memo, date_str')) return { rows: scenario.order ? [scenario.order] : [] };
      if (s.startsWith('UPDATE order_submissions SET') && s.includes('reverse_sync_last_auto_at = NOW()')) { calls.updates.push({ s, params }); return { rowCount: 1 }; }
      if (s.includes("SET status='applied'")) { calls.applied.push(params); return { rowCount: 1 }; }
      if (s.includes("SET status='dismissed'")) { calls.dismissed.push(params); return { rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
}

// headers: 주문자0 아이디1 수취인2 연락처3 주소4 비고5 일자6
// 사각형 cols = editCols(memo=5) ∪ id(phone3,recipient2,address4) → minC=2,maxC=5 → gridRow idx = col-2
// gridRow = [수취인, 연락처, 주소, 비고]
function gridRow(recipient, phone, address, memo) { return [recipient, phone, address, memo]; }

const baseCandidate = { id: 101, os_id: 'os-1', sheet_id: 's1', tab_name: 'T', tab_gid: '9', sheet_row: 10, field: 'memo', new_value: '새메모', detected_edit_seq: 5 };
const baseOrder = { orderer: '홍', user_id: 'u', memo: '옛메모', date_str: '', bank: '', account: '', depositor: '',
  phone: '010-1111-2222', recipient: '홍길동', address: '서울시', last_edit_seq: 5, deleted_at: null, mirror_status: 'written', reverse_sync_last_auto_at: null };

process.env.SHEET_REVERSE_SYNC = '1';
process.env.REVERSE_SYNC_AUTO = '1';
process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';

async function withScenario(scenario, grid, fn) {
  _enqueues = []; _rectGrid = grid;
  const pool = makePool(scenario);
  ledger.__setPoolForTest(pool);
  try { const out = await fn(pool); return out; }
  finally { ledger.__setPoolForTest(null); }
}

async function run() {
  // ── 안전필드 화이트리스트: price/order_num/phone 하드 제외 ──
  process.env.REVERSE_SYNC_AUTO_FIELDS = 'orderer,memo,price,order_num,phone,address';
  const safe = ledger._autoSafeFields();
  assert.ok(safe.includes('orderer') && safe.includes('memo'), '안전필드 포함');
  assert.ok(!safe.includes('price') && !safe.includes('order_num') && !safe.includes('phone') && !safe.includes('address'), '돈·송장·신원 하드제외');
  delete process.env.REVERSE_SYNC_AUTO_FIELDS;
  console.log('  안전필드 화이트리스트 통과');

  // ── (A) 해피패스: identity 일치 + 셀=제안값 → 자동적용 ──
  let r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder } },
    [gridRow('홍길동', '01011112222', '서울시', '새메모')],
    () => ledger.autoApplyReverseSync({}));
  assert.equal(r.applied, 1, 'A: applied=1');
  assert.equal(r.orders, 1, 'A: orders=1');
  assert.equal(_enqueues.length, 1, 'A: order_update 1건 enqueue');
  assert.equal(_enqueues[0].type, 'order_update');
  assert.equal(_enqueues[0].payload.edits[0].field, 'memo');
  assert.equal(_enqueues[0].payload.edits[0].newValue, '새메모');
  console.log('  (A) 해피패스 자동적용 통과');

  // ── (B) identity 불일치(수취인 다름) → 미적용 ──
  r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder } },
    [gridRow('김철수', '01011112222', '서울시', '새메모')],
    () => ledger.autoApplyReverseSync({}));
  assert.equal(r.applied, 0, 'B: 신원 불일치 → 미적용');
  assert.equal(r.reverifyFail, 1, 'B: reverifyFail 집계');
  assert.equal(_enqueues.length, 0, 'B: enqueue 없음');
  console.log('  (B) identity 불일치 차단 통과');

  // ── (C) 셀이 제안값과 다름(사람이 또 변경) → 적용 안 함 + 제안 정리 ──
  r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder } },
    [gridRow('홍길동', '01011112222', '서울시', '또다른값')],
    (pool) => ledger.autoApplyReverseSync({}).then(o => ({ o, pool })));
  assert.equal(r.o.applied, 0, 'C: 셀 변경 → 미적용');
  assert.equal(r.pool.calls.dismissed.length, 1, 'C: 재검증 실패 제안 dismiss');
  assert.equal(_enqueues.length, 0, 'C: enqueue 없음');
  console.log('  (C) 셀 재검증 실패 → dismiss 통과');

  // ── (D) 쿨다운 활성 → 스킵(적용/정리 안 함) ──
  r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder, reverse_sync_last_auto_at: new Date().toISOString() } },
    [gridRow('홍길동', '01011112222', '서울시', '새메모')],
    (pool) => ledger.autoApplyReverseSync({}).then(o => ({ o, pool })));
  assert.equal(r.o.applied, 0, 'D: 쿨다운 → 미적용');
  assert.equal(r.pool.calls.dismissed.length, 0, 'D: 쿨다운은 제안 보존(스킵만)');
  console.log('  (D) 쿨다운 스킵 통과');

  // ── (E) 이미 동기(DB==시트) → no-op dismiss ──
  r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder, memo: '새메모' } },
    [gridRow('홍길동', '01011112222', '서울시', '새메모')],
    (pool) => ledger.autoApplyReverseSync({}).then(o => ({ o, pool })));
  assert.equal(r.o.applied, 0, 'E: 이미 동기 → 미적용');
  assert.equal(r.pool.calls.dismissed.length, 1, 'E: no-op 제안 dismiss');
  console.log('  (E) no-op dismiss 통과');

  // ── (F) 게이트 OFF → skipped ──
  process.env.REVERSE_SYNC_AUTO = '0';
  const off = await ledger.autoApplyReverseSync({});
  assert.equal(off.skipped, true, 'F: REVERSE_SYNC_AUTO=0 → skipped');
  process.env.REVERSE_SYNC_AUTO = '1';
  console.log('  (F) 게이트 OFF skip 통과');

  // ── (G) 심판[중대2]: 라이브 헤더에서 신원칸(수취인) 소실 → idFields<3 → 탭 스킵(미적용) ──
  _liveHeaders = ['주문자', '아이디', '연락처', '주소', '비고', '일자']; // 수취인 없음
  r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder } },
    [gridRow('홍길동', '01011112222', '서울시', '새메모')],
    () => ledger.autoApplyReverseSync({}));
  assert.equal(r.applied, 0, 'G: 신원 3칸 미매핑 → 미적용');
  assert.equal(r.tabsSkipped, 1, 'G: 탭 스킵 집계');
  assert.equal(_enqueues.length, 0, 'G: enqueue 없음');
  _liveHeaders = ['주문자', '아이디', '수취인', '연락처', '주소', '비고', '일자']; // 복구
  console.log('  (G) idFields<3 탭 스킵 통과');

  // ── (H) 심판[치명1]: 감지 후 관리자 편집(last_edit_seq 6 > detected 5) → G6 dismiss(관리자값 보존) ──
  r = await withScenario({ candidates: [{ ...baseCandidate, detected_edit_seq: 5 }], order: { ...baseOrder, last_edit_seq: 6 } },
    [gridRow('홍길동', '01011112222', '서울시', '새메모')],
    (pool) => ledger.autoApplyReverseSync({}).then(o => ({ o, pool })));
  assert.equal(r.o.applied, 0, 'H: G6 stale → 미적용(관리자편집 보존)');
  assert.equal(r.pool.calls.dismissed.length, 1, 'H: stale 제안 dismiss');
  assert.equal(_enqueues.length, 0, 'H: enqueue 없음');
  console.log('  (H) G6 편집경쟁 stale 차단 통과');

  // ── (I) 치명1: 적용 시 UPDATE의 last_edit_seq 파라미터 == enqueue editSeq(동일값 → 큐워커 no-op) ──
  r = await withScenario({ candidates: [{ ...baseCandidate }], order: { ...baseOrder } },
    [gridRow('홍길동', '01011112222', '서울시', '새메모')],
    (pool) => ledger.autoApplyReverseSync({}).then(() => pool));
  const upd = r.calls.updates[0];
  const seqParam = upd.params[upd.params.length - 1];     // UPDATE 마지막 파라미터 = editSeq
  assert.equal(seqParam, _enqueues[0].payload.editSeq, 'I: UPDATE last_edit_seq == enqueue editSeq');
  assert.ok(/last_edit_seq = GREATEST/.test(upd.s), 'I: UPDATE에 last_edit_seq 단조증가 포함');
  console.log('  (I) last_edit_seq 단조증가 정합 통과');
}

run().then(() => console.log('reverseSyncAuto tests passed')).catch(e => { console.error(e); process.exit(1); });
