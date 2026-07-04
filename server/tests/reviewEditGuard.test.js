/**
 * 리뷰 수정요청 소유권 가드 회귀 테스트
 *   무인증 엔드포인트 GET /api/review-edit/my-files 가:
 *   1) phone8 8자리가 아니면 400
 *   2) 강한-키(review_index.phone8 / participation_links.phone8) 소유가 없으면 403
 *      (이름만 아는 제3자가 타인 제출 이미지를 조회하는 것 차단)
 *   3) 소유 확인 시 200 + 파일목록
 *   4) 소유권 쿼리는 강한-키만 사용하고 이름 기반 매칭을 절대 쓰지 않음
 *   을 고정한다.
 * 실행: node tests/reviewEditGuard.test.js
 */
const assert = require('assert');

// ── pool 모킹 (require 캐시 주입 — 라우터/서비스 로드 전에) ──
const poolPath = require.resolve('../src/db/pool');
const captured = { queries: [] };
let ownershipRows = [];   // _verifyRowOwnership 결과

const fakePool = {
  query: async (sql, params) => {
    captured.queries.push({ sql, params });
    if (/FROM reviewers/.test(sql)) return { rows: [] };                       // 타계정 없음
    if (/SELECT 1\s+FROM review_index/.test(sql)) return { rows: ownershipRows };
    if (/FROM review_submissions/.test(sql)) {
      return { rows: [{ file_id: 'F1', file_name: 'a.jpg', file_url: 'u', slot_key: 'review', uploaded_at: null }] };
    }
    if (/FROM tab_configs/.test(sql)) return { rows: [{ capture_slots: null }] };
    if (/FROM review_edit_requests/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
  connect: async () => ({ query: fakePool.query, release() {} }),
};
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };

const router = require('../src/routes/reviewEdit.routes');

function findHandler(method, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} 라우트가 있어야 함`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;  // 마지막 = 실제 핸들러
}

function mockRes() {
  return {
    _status: 200, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

async function run() {
  const myFiles = findHandler('get', '/my-files');

  // 1) phone8 형식 불량 → 400
  let res = mockRes();
  await myFiles({ query: { phone8: '123', sheetId: 'S', tabName: 'T', rowIndex: '5' } }, res);
  assert.strictEqual(res._status, 400, 'phone8 8자리 아니면 400이어야 함');

  // 2) 소유 없음 → 403 (타인 이미지 조회 차단)
  ownershipRows = [];
  res = mockRes();
  await myFiles({ query: { phone8: '12345678', sheetId: 'S', tabName: 'T', rowIndex: '5' } }, res);
  assert.strictEqual(res._status, 403, '소유 검증 실패 시 403이어야 함');

  // 3) 소유 확인 → 200 + files
  ownershipRows = [{ ok: 1 }];
  res = mockRes();
  await myFiles({ query: { phone8: '12345678', sheetId: 'S', tabName: 'T', rowIndex: '5' } }, res);
  assert.strictEqual(res._status, 200, '소유 확인 시 200이어야 함');
  assert.ok(res._json && res._json.ok === true, 'ok:true 를 반환해야 함');
  assert.ok(Array.isArray(res._json.files) && res._json.files.length === 1, '파일 목록을 반환해야 함');
  // 응답에 Drive fileId 는 포함(썸네일용)하되 그 외 내부 필드는 최소화
  assert.strictEqual(res._json.files[0].fileId, 'F1', 'fileId 를 반환해야 함(썸네일용)');

  // 4) 소유권 쿼리는 강한-키 전용, 이름 매칭 금지
  const ownQ = captured.queries.find(q => /SELECT 1\s+FROM review_index/.test(q.sql));
  assert.ok(ownQ, '소유권 쿼리가 실행되어야 함');
  assert.ok(/ri\.phone8 = ANY/.test(ownQ.sql) && /pl\.phone8 = ANY/.test(ownQ.sql),
    '강한-키(phone8 / participation_links.phone8)로만 소유 판정해야 함');
  assert.ok(!/reviewer_name/.test(ownQ.sql) && !/recipient_name/.test(ownQ.sql),
    '이름 기반 매칭을 쓰면 안 됨(무인증 타인 스크래핑 차단)');

  console.log('✓ reviewEditGuard: my-files 소유권 가드 통과 (400/403/200 + 강한-키 전용)');
}

// sse.js 등이 setInterval(하트비트)로 이벤트루프를 잡아 종료를 막으므로 명시적 종료
run()
  .then(() => process.exit(0))
  .catch(e => { console.error('✗ reviewEditGuard 실패:', e.stack || e.message); process.exit(1); });
