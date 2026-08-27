'use strict';

// 작업표 열 규격은 원본 오더 생성 시점에만 결정한다. 현재 릴리스는 v1만
// 생성·처리하며, v2는 후속 열 자동화가 모두 배포될 때까지 fail-closed 한다.
const LEGACY_WORKBOARD_SCHEMA_VERSION = 1;
const AUTOMATED_WORKBOARD_SCHEMA_VERSION = 2;
const VALID_WORKBOARD_SCHEMA_VERSIONS = new Set([
  LEGACY_WORKBOARD_SCHEMA_VERSION,
  AUTOMATED_WORKBOARD_SCHEMA_VERSION,
]);
const SUPPORTED_WORKBOARD_SCHEMA_VERSIONS = new Set([
  LEGACY_WORKBOARD_SCHEMA_VERSION,
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
