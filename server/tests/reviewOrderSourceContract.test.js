const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 신규 인트라넷 → 리뷰웹 수신 계약의 최소 불변식.
// 실제 HTTP/DB 이전에 경계값을 고정해, 재시도·중복 방지 키가 임의 문자열로 흐르지 않게 한다.
const {
  SourceContractError,
  normalizeReviewOrderSourceContract,
} = require('../src/services/reviewOrderSourceContract.service');
const { isAutomatedWorkboardEnabled } = require('../src/services/workboardSchema.service');
const orderRouteSource = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('기존 형식(원본 식별자 없음)은 명시적으로 호환 처리한다', () => {
  assert.strictEqual(normalizeReviewOrderSourceContract({ title: '기존 오더' }), null);
});

test('신규 형식은 원본 ID·버전·재시도 키를 정규화한다', () => {
  assert.deepStrictEqual(
    normalizeReviewOrderSourceContract({
      source_review_order_id: 'ro_20260812_001',
      source_revision: '2',
      idempotency_key: 'ro_20260812_001:2',
      intranet_advertiser_id: 'adv_1042',
      intranet_advertiser_name: '제주 수산 주식회사',
      intranet_advertiser_contact: '010-1234-5678',
      intranet_advertiser_business_number: '123-45-67890',
    }),
    {
      sourceReviewOrderId: 'ro_20260812_001',
      sourceRevision: 2,
      workboardSchemaVersion: 1,
      workSeriesId: '',
      workRound: 1,
      idempotencyKey: 'ro_20260812_001:2',
      intranetAdvertiserId: 'adv_1042',
      intranetAdvertiserName: '제주 수산 주식회사',
      intranetAdvertiserContact: '010-1234-5678',
      intranetAdvertiserBusinessNumber: '123-45-67890',
    }
  );
});

test('작업표 규격은 누락 시 v1이며 정의된 v1·v2만 계약으로 수신한다', () => {
  const base = {
    source_review_order_id: 'ro_20260812_001',
    source_revision: 1,
    idempotency_key: 'ro_20260812_001:1',
  };
  assert.strictEqual(normalizeReviewOrderSourceContract(base).workboardSchemaVersion, 1);
  const v2 = normalizeReviewOrderSourceContract({ ...base, workboard_schema_version: 2, work_series_id: 'series_01', work_round: 2 });
  assert.strictEqual(v2.workboardSchemaVersion, 2);
  assert.strictEqual(v2.workSeriesId, 'series_01');
  assert.strictEqual(v2.workRound, 2);
  assert.throws(() => normalizeReviewOrderSourceContract({ ...base, workboard_schema_version: 2 }), SourceContractError);
  assert.throws(() => normalizeReviewOrderSourceContract({ ...base, workboard_schema_version: 3 }), SourceContractError);
});

test('v2 생성은 본섭 킬스위치를 명시적으로 켠 경우에만 연다', () => {
  assert.strictEqual(isAutomatedWorkboardEnabled({}), false);
  assert.strictEqual(isAutomatedWorkboardEnabled({ WORKBOARD_V2_ENABLED: 'true' }), true);
  assert.strictEqual(isAutomatedWorkboardEnabled({ WORKBOARD_V2_ENABLED: '0' }), false);
});

test('인트라넷 수신 INSERT는 광고주 사업자번호까지 모든 컬럼 값을 전달한다', () => {
  assert.ok(orderRouteSource.includes('$37,$38,$39,$40,\'submitted\',$41,$42,$43,$44,$45,$46,$47'));
  assert.match(orderRouteSource, /err\.intakeHttp500 = true;\r?\n\s+next\(err\);/);
  const errorMiddleware = fs.readFileSync(path.join(__dirname, '../src/middleware/error.middleware.js'), 'utf8');
  assert.match(errorMiddleware, /if \(err\.intakeHttp500\) \{\r?\n\s+return res\.status\(500\)\.json\(\{\r?\n\s+ok: false,\r?\n\s+code: 'order_intake_failed'/);
});

test('신규 형식의 식별자 일부만 전달하면 거부한다', () => {
  assert.throws(
    () => normalizeReviewOrderSourceContract({ source_review_order_id: 'ro_20260812_001' }),
    SourceContractError
  );
});

test('버전 0·부적절한 재시도 키는 거부한다', () => {
  assert.throws(
    () => normalizeReviewOrderSourceContract({
      source_review_order_id: 'ro_20260812_001',
      source_revision: 0,
      idempotency_key: 'ro_20260812_001:0',
    }),
    SourceContractError
  );
  assert.throws(
    () => normalizeReviewOrderSourceContract({
      source_review_order_id: 'ro_20260812_001',
      source_revision: 1,
      idempotency_key: '<script>alert(1)</script>',
    }),
    SourceContractError
  );
});

test('식별자를 잘라 저장하지 않고 길이 초과를 거부한다', () => {
  assert.throws(
    () => normalizeReviewOrderSourceContract({
      source_review_order_id: `ro_${'a'.repeat(130)}`,
      source_revision: 1,
      idempotency_key: 'ro_20260812_001:1',
    }),
    SourceContractError
  );
});

test('신규 원본 광고주는 이름 없이 수신하지 않는다', () => {
  assert.throws(
    () => normalizeReviewOrderSourceContract({
      source_review_order_id: 'ro_20260812_001',
      source_revision: 1,
      idempotency_key: 'ro_20260812_001:1',
      intranet_advertiser_id: 'adv_1042',
    }),
    SourceContractError
  );
});

test('A source revision keeps its source id and increments monotonically', () => {
  const current = normalizeReviewOrderSourceContract({
    source_review_order_id: 'ro_20260812_001',
    source_revision: 1,
    idempotency_key: 'ro_20260812_001:1',
  });
  const next = normalizeReviewOrderSourceContract({
    source_review_order_id: 'ro_20260812_001',
    source_revision: current.sourceRevision + 1,
    idempotency_key: 'ro_20260812_001:2',
  });
  assert.strictEqual(next.sourceReviewOrderId, current.sourceReviewOrderId);
  assert.strictEqual(next.sourceRevision, 2);
});

console.log(`\nreviewOrderSourceContract: ${passed} passed`);
