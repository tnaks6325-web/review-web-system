const { logger } = require('../utils/logger');

/**
 * Express 글로벌 에러 핸들러
 * GAS corsOutput({ error: err.message }) 패턴 대체
 *
 * GAS 호환성: 가능한 한 HTTP 200 + error 필드로 반환
 * (프론트가 res.error 로 에러 감지하므로)
 */
function errorHandler(err, req, res, next) {
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // CORS 오류
  if (err.message && err.message.includes('CORS 차단')) {
    return res.status(403).json({ error: 'CORS 정책 위반' });
  }

  // 인증 오류
  if (err.status === 401) {
    return res.status(401).json({ error: err.message });
  }

  // 기본: GAS 호환 에러 응답 (HTTP 200, error 필드)
  res.status(200).json({
    error: process.env.NODE_ENV === 'production'
      ? '서버 오류가 발생했습니다.'
      : err.message,
  });
}

module.exports = { errorHandler };
