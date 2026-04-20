/**
 * Sentry 초기화 모듈
 * 환경변수 SENTRY_DSN이 설정된 경우에만 Sentry 활성화
 * 미설정 시 noop — 앱 동작에 영향 없음
 */
const Sentry = require('@sentry/node');
const { logger } = require('./logger');

let sentryEnabled = false;

function initSentry(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('[Sentry] SENTRY_DSN 미설정 — Sentry 비활성화 (자체 메트릭만 수집)');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.APP_VERSION || '2.6.0-monitoring',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_RATE || '0.2'),
      integrations: [
        Sentry.httpIntegration(),
        Sentry.expressIntegration({ app }),
      ],
      beforeSend(event) {
        // PII 제거: 요청 바디에서 비밀번호 등 민감 정보 필터링
        if (event.request && event.request.data) {
          try {
            const data = typeof event.request.data === 'string'
              ? JSON.parse(event.request.data) : event.request.data;
            for (const key of ['pw', 'password', 'token', 'refreshToken', 'secret']) {
              if (data[key]) data[key] = '[FILTERED]';
            }
            event.request.data = JSON.stringify(data);
          } catch (_) { /* 파싱 실패 무시 */ }
        }
        return event;
      },
    });

    sentryEnabled = true;
    logger.info('[Sentry] 초기화 완료 — DSN: .../' + dsn.split('/').pop());
  } catch (err) {
    logger.error(`[Sentry] 초기화 실패: ${err.message}`);
  }
}

function captureException(err, context = {}) {
  if (sentryEnabled) {
    Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) {
        scope.setExtra(k, v);
      }
      Sentry.captureException(err);
    });
  }
}

function captureMessage(msg, level = 'info') {
  if (sentryEnabled) {
    Sentry.captureMessage(msg, level);
  }
}

function isSentryEnabled() {
  return sentryEnabled;
}

/**
 * Sentry 에러 핸들러 (Express 글로벌 에러 핸들러 직전에 배치)
 */
function sentryErrorHandler() {
  if (sentryEnabled) {
    return Sentry.setupExpressErrorHandler
      ? Sentry.setupExpressErrorHandler
      : (err, req, res, next) => { Sentry.captureException(err); next(err); };
  }
  return (err, req, res, next) => next(err);
}

module.exports = {
  initSentry,
  captureException,
  captureMessage,
  isSentryEnabled,
  sentryErrorHandler,
  Sentry,
};
