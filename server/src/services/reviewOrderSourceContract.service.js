'use strict';

const { WorkboardSchemaError, normalizeWorkboardSchemaVersion } = require('./workboardSchema.service');

/**
 * Intranet review-order source contract.
 *
 * A legacy sender may omit all four source fields while the transition is in
 * progress. Once a sender starts the source contract it must send every
 * identity field, so retries can never create a second work order.
 */
class SourceContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceContractError';
  }
}

function _string(value) {
  return String(value == null ? '' : value).trim();
}

function _safeIdentifier(value, label, maxLength) {
  const result = _string(value);
  if (!result || result.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(result)) {
    throw new SourceContractError(`${label} 형식이 올바르지 않습니다.`);
  }
  return result;
}

function _boundedText(value, label, maxLength, required = false) {
  const result = _string(value);
  if ((required && !result) || result.length > maxLength) {
    throw new SourceContractError(`${label} 값이 올바르지 않습니다.`);
  }
  return result;
}

function _workboardSchemaVersion(value) {
  try {
    return normalizeWorkboardSchemaVersion(value);
  } catch (error) {
    if (error instanceof WorkboardSchemaError) throw new SourceContractError(error.message);
    throw error;
  }
}

function _workRound(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) {
    throw new SourceContractError('작업 차수는 1 이상의 정수여야 합니다.');
  }
  return n;
}

function normalizeReviewOrderSourceContract(input) {
  const body = input || {};
  const raw = {
    sourceReviewOrderId: _string(body.source_review_order_id),
    sourceRevision: body.source_revision,
    workboardSchemaVersion: body.workboard_schema_version,
    workSeriesId: _string(body.work_series_id),
    workRound: body.work_round,
    idempotencyKey: _string(body.idempotency_key),
    intranetAdvertiserId: _string(body.intranet_advertiser_id),
    intranetAdvertiserName: _string(body.intranet_advertiser_name),
    intranetAdvertiserContact: _string(body.intranet_advertiser_contact),
    intranetAdvertiserBusinessNumber: _string(body.intranet_advertiser_business_number),
  };

  const hasAny = Boolean(
    raw.sourceReviewOrderId || raw.sourceRevision !== undefined || raw.workboardSchemaVersion !== undefined || raw.workSeriesId || raw.workRound !== undefined || raw.idempotencyKey || raw.intranetAdvertiserId
      || raw.intranetAdvertiserName || raw.intranetAdvertiserContact || raw.intranetAdvertiserBusinessNumber
  );
  if (!hasAny) return null;

  if (!raw.sourceReviewOrderId || raw.sourceRevision === undefined || !raw.idempotencyKey) {
    throw new SourceContractError('원본 오더 ID, 수정 버전, 재시도 키는 함께 필요합니다.');
  }

  const sourceRevision = Number(raw.sourceRevision);
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1 || sourceRevision > 2147483647) {
    throw new SourceContractError('수정 버전은 1 이상의 정수여야 합니다.');
  }

  const workboardSchemaVersion = _workboardSchemaVersion(raw.workboardSchemaVersion);
  const workRound = raw.workRound === undefined ? 1 : _workRound(raw.workRound);
  const workSeriesId = raw.workSeriesId
    ? _safeIdentifier(raw.workSeriesId, '작업 계열 ID', 128)
    : '';
  if (workboardSchemaVersion === 2 && !workSeriesId) {
    throw new SourceContractError('v2 작업에는 작업 계열 ID가 필요합니다.');
  }
  return {
    sourceReviewOrderId: _safeIdentifier(raw.sourceReviewOrderId, '원본 오더 ID', 128),
    sourceRevision,
    workboardSchemaVersion,
    workSeriesId,
    workRound,
    idempotencyKey: _safeIdentifier(raw.idempotencyKey, '재시도 키', 160),
    intranetAdvertiserId: raw.intranetAdvertiserId
      ? _safeIdentifier(raw.intranetAdvertiserId, '인트라넷 광고주 ID', 128)
      : '',
    intranetAdvertiserName: raw.intranetAdvertiserId
      ? _boundedText(raw.intranetAdvertiserName, '인트라넷 광고주명', 200, true)
      : '',
    intranetAdvertiserContact: _boundedText(raw.intranetAdvertiserContact, '인트라넷 광고주 연락처', 300),
    intranetAdvertiserBusinessNumber: _boundedText(raw.intranetAdvertiserBusinessNumber, '인트라넷 사업자번호', 80),
  };
}

module.exports = {
  SourceContractError,
  normalizeReviewOrderSourceContract,
};
