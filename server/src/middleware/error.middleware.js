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
  /* ★★ 본문 크기 초과(413) — GAS 호환 200 으로 접지 않는다.
     이건 "기다리면 풀리는 실패"가 아니라 **더 줄여 보내야 풀리는 실패**라, 클라이언트가
     429(분당 상한)와 구분할 수 있어야 재시도 전략이 갈린다(구매 캡처 업로드 경로).
     본문에 `error` 는 그대로 실어 기존 소비처(res.error 검사) 계약은 유지한다. */
  if (err.status === 413 || err.statusCode === 413 || err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: '전송 용량이 초과되었습니다. 이미지 크기를 줄여 다시 시도해주세요.' });
  }


  // 기본: GAS 호환 에러 응답 (HTTP 200, error 필드)
  // ★ 관리자 API 및 캠페인 API는 디버깅을 위해 실제 에러 메시지 포함
  // /api/manual-order/ = 관리자 전용 대리제출 도구 — 실패 원인이 곧 조치 안내라 마스킹하면 못 쓴다
  //   ★ 리뷰웹시스템[3버전]은 같은 도구를 /api/trackb/manual-order/* 프록시로 쓴다(인트라넷 SSO
  //     토큰이 Track A 경로에 도달 불가) — 화면이 같으니 안내도 같아야 한다.
  const isAdminApi = req.path && (req.path.startsWith('/api/admin/') || req.path.startsWith('/api/campaign/')
    || req.path.startsWith('/api/order/') || req.path.startsWith('/api/manual-order/')
    || req.path.startsWith('/api/trackb/manual-order/'));
  res.status(200).json({
    error: (process.env.NODE_ENV === 'production' && !isAdminApi)
      ? '서버 오류가 발생했습니다.'
      : err.message,
  });
}

module.exports = { errorHandler };
