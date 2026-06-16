const { logger } = require('../utils/logger');
const { captureException, isSentryEnabled } = require('../utils/sentry');
const { logAbnormal } = require('../services/errorLog.service');

/**
 * 요청 경로 → 비정상 로그 flow/step 매핑
 * (미처리 라우트 에러가 어떤 기능에서 났는지 자연어 설명에 반영)
 */
const PATH_FLOW_MAP = [
  [/^\/api\/submit\/order/,        { flow: 'order_submit',  step: '' }],
  [/^\/api\/submit\/review/,       { flow: 'review_submit', step: '' }],
  [/^\/api\/image\/image-upload/,  { flow: 'order_submit',  step: 'image_upload' }],
  [/^\/api\/image\/image-extract/, { flow: 'image_extract', step: 'gemini_call' }],
  [/^\/api\/reviewer/,             { flow: 'reviewer',      step: '' }],
  [/^\/api\/admin/,                { flow: 'admin',         step: '' }],
  [/^\/api\/campaign/,             { flow: 'campaign',      step: '' }],
  [/^\/api\/drive/,                { flow: 'drive',         step: '' }],
  [/^\/api\/(index|search)/,       { flow: 'index_build',   step: '' }],
];

function flowFromPath(p) {
  for (const [re, v] of PATH_FLOW_MAP) {
    if (re.test(p || '')) return v;
  }
  return { flow: 'unknown', step: '' };
}

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

  // ── 비정상 로그(이상로그) 영구 기록 — fire-and-forget, 절대 throw 안 함 ──
  const { flow, step } = flowFromPath(req.path);
  logAbnormal({
    flow,
    step,
    severity: errorContext.statusCode >= 500 ? 'error' : 'warn',
    error: err,
    context: {
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: errorContext.userAgent,
      statusCode: errorContext.statusCode,
      userId: (req.admin && req.admin.name) || undefined,
    },
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
  const isAdminApi = req.path && (req.path.startsWith('/api/admin/') || req.path.startsWith('/api/campaign/') || req.path.startsWith('/api/order/'));
  res.status(200).json({
    error: (process.env.NODE_ENV === 'production' && !isAdminApi)
      ? '서버 오류가 발생했습니다.'
      : err.message,
  });
}

module.exports = { errorHandler };
