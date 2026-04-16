/**
 * GAS 응답 형식 호환 포맷터
 * GAS corsOutput() 호환 응답
 */

// GAS와 동일하게 최상위 레벨에 필드를 직접 배치
exports.gasOk = (data) => ({ ...data });

exports.gasError = (message) => ({ error: message });

exports.gasSuccess = (extra = {}) => ({ success: true, ...extra });

// HTTP 상태코드는 기본 200 반환 (GAS 호환)
// 에러도 200으로 반환하고 error 필드로 구분
