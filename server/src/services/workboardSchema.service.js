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

module.exports = {
  LEGACY_WORKBOARD_SCHEMA_VERSION,
  AUTOMATED_WORKBOARD_SCHEMA_VERSION,
  WorkboardSchemaError,
  normalizeWorkboardSchemaVersion,
  assertSupportedWorkboardSchemaVersion,
};
