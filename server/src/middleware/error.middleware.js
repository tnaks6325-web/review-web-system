const { logger } = require('../utils/logger');
const { captureException, isSentryEnabled } = require('../utils/sentry');

/**
 * Express 글로벌 에러 핸들러
 * GAS corsOutput({ error: err.message }) 패턴 대체
 *
 * GAS 호환성: 가능한 한 HTTP 200 + error 필드로 반환
 * (프론트가 res.error 로 에러 감지하므로)
 *
 * Phase 6: Sentry captureException 통합
 */
function errorHandler(err, req, res, next) {
  // ── 구조화 로깅 ──
  const errorContext = {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    query: Object.keys(req.query || {}).length ? req.query : undefined,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] || '').substring(0, 120),
    statusCode: err.status || err.statusCode || 500,
  };

  logger.error(errorContext);

  // ── Sentry 에러 전송 ──
  captureException(err, {
    path: req.path,
    method: req.method,
    query: req.query,
    ip: req.ip,
    statusCode: errorContext.statusCode,
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
  // ★ 관리자 API 및 캠페인 API는 디버깅을 위해 실제 에러 메시지 포함
  const isAdminApi = req.path && (req.path.startsWith('/api/admin/') || req.path.startsWith('/api/campaign/'));
  res.status(200).json({
    error: (process.env.NODE_ENV === 'production' && !isAdminApi)
      ? '서버 오류가 발생했습니다.'
      : err.message,
  });
}

module.exports = { errorHandler };
