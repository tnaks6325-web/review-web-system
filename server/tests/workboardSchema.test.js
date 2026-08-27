const assert = require('assert');
const {
  LEGACY_WORKBOARD_SCHEMA_VERSION,
  AUTOMATED_WORKBOARD_SCHEMA_VERSION,
  WorkboardSchemaError,
  normalizeWorkboardSchemaVersion,
  assertSupportedWorkboardSchemaVersion,
} = require('../src/services/workboardSchema.service');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('누락된 규격은 기존 작업표와 같은 v1으로 고정한다', () => {
  assert.strictEqual(normalizeWorkboardSchemaVersion(), LEGACY_WORKBOARD_SCHEMA_VERSION);
});

test('단계형 상품·옵션 소비자가 준비된 v2는 생성 경로에서 허용한다', () => {
  assert.strictEqual(normalizeWorkboardSchemaVersion(2), AUTOMATED_WORKBOARD_SCHEMA_VERSION);
  assert.strictEqual(assertSupportedWorkboardSchemaVersion(2), AUTOMATED_WORKBOARD_SCHEMA_VERSION);
});

test('정의되지 않은 규격은 수신 단계에서 거부한다', () => {
  assert.throws(() => normalizeWorkboardSchemaVersion(3), (error) => (
    error instanceof WorkboardSchemaError && error.code === 'invalid_workboard_schema_version'
  ));
});

console.log(`\nworkboardSchema: ${passed} passed`);
