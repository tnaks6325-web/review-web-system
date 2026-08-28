'use strict';

// 작업표 열 규격은 원본 오더 생성 시점에만 결정한다. v2는 상품·단계형 옵션
// 원본 검증과 전용 열 생성·동기화가 함께 배포된 뒤에만 활성화한다.
const LEGACY_WORKBOARD_SCHEMA_VERSION = 1;
const AUTOMATED_WORKBOARD_SCHEMA_VERSION = 2;
const VALID_WORKBOARD_SCHEMA_VERSIONS = new Set([
  LEGACY_WORKBOARD_SCHEMA_VERSION,
  AUTOMATED_WORKBOARD_SCHEMA_VERSION,
]);
const SUPPORTED_WORKBOARD_SCHEMA_VERSIONS = new Set([
  LEGACY_WORKBOARD_SCHEMA_VERSION,
  AUTOMATED_WORKBOARD_SCHEMA_VERSION,
]);

class WorkboardSchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkboardSchemaError';
    this.code = code;
  }
}

function normalizeWorkboardSchemaVersion(value) {
  if (value === undefined || value === null || value === '') {
    return LEGACY_WORKBOARD_SCHEMA_VERSION;
  }
  const version = Number(value);
  if (!Number.isInteger(version) || !VALID_WORKBOARD_SCHEMA_VERSIONS.has(version)) {
    throw new WorkboardSchemaError('invalid_workboard_schema_version', '작업표 규격 버전은 1 또는 2여야 합니다.');
  }
  return version;
}

function assertSupportedWorkboardSchemaVersion(value) {
  const version = normalizeWorkboardSchemaVersion(value);
  if (!SUPPORTED_WORKBOARD_SCHEMA_VERSIONS.has(version)) {
    throw new WorkboardSchemaError('schema_not_supported', '아직 지원되지 않는 작업표 규격입니다.');
  }
  return version;
}

// 본섭 최초 반영 직후에는 코드·DB만 배포하고 새 v2 데이터 생성을 멈춰 둘 수 있다.
// 값은 명시적으로 켠 경우에만 true다. 끄면 기존 v2를 지우거나 v1로 재해석하지 않고,
// 아직 생성되지 않은 v2 원본만 v1 경로로 안전하게 보류한다.
function isAutomatedWorkboardEnabled(env = process.env) {
  return /^(1|true|t|yes|y|on)$/i.test(String((env && env.WORKBOARD_V2_ENABLED) || '').trim());
}

module.exports = {
  LEGACY_WORKBOARD_SCHEMA_VERSION,
  AUTOMATED_WORKBOARD_SCHEMA_VERSION,
  WorkboardSchemaError,
  normalizeWorkboardSchemaVersion,
  assertSupportedWorkboardSchemaVersion,
  isAutomatedWorkboardEnabled,
};
