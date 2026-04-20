/**
 * API 메트릭 수집 미들웨어
 * 요청 수, 응답 시간, 에러율, 상태코드 분포를 인메모리 수집
 * /api/diag/metrics 또는 /health에서 조회 가능
 */
const { logger } = require('../utils/logger');
const { captureException } = require('../utils/sentry');

// ── 메트릭 저장소 (인메모리) ──
const metrics = {
  startTime: Date.now(),
  totalRequests: 0,
  totalErrors: 0,      // 5xx 에러
  clientErrors: 0,     // 4xx 에러
  statusCodes: {},      // { 200: 1234, 404: 5, ... }
  
  // 라우트별 응답시간 (최근 1000개 유지)
  routeTimings: {},     // { 'GET /api/search': { count, totalMs, maxMs, minMs, errors } }
  
  // 최근 에러 로그 (최대 50개)
  recentErrors: [],
  
  // 분당 요청수 (슬라이딩 윈도우 60초)
  _minuteSlots: [],     // [{ ts, count }]
};

const MAX_RECENT_ERRORS = 50;
const MAX_TIMING_ENTRIES = 200;

/**
 * 요청 시작/종료 타이밍 + 에러 수집 미들웨어
 */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  
  // 응답 완료 시 메트릭 기록
  res.on('finish', () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      const routeKey = `${req.method} ${req.route?.path || req.path}`;
      
      // 전체 카운트
      metrics.totalRequests++;
      
      // 상태코드 분포
      metrics.statusCodes[status] = (metrics.statusCodes[status] || 0) + 1;
      
      // 에러 카운트
      if (status >= 500) {
        metrics.totalErrors++;
      } else if (status >= 400) {
        metrics.clientErrors++;
      }
      
      // 라우트별 타이밍
      if (!metrics.routeTimings[routeKey]) {
        // 라우트 수 제한
        if (Object.keys(metrics.routeTimings).length >= MAX_TIMING_ENTRIES) {
          const oldest = Object.entries(metrics.routeTimings)
            .sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
          if (oldest) delete metrics.routeTimings[oldest[0]];
        }
        metrics.routeTimings[routeKey] = {
          count: 0, totalMs: 0, maxMs: 0, minMs: Infinity, errors: 0, lastAt: Date.now(),
        };
      }
      const rt = metrics.routeTimings[routeKey];
      rt.count++;
      rt.totalMs += durationMs;
      rt.maxMs = Math.max(rt.maxMs, durationMs);
      rt.minMs = Math.min(rt.minMs, durationMs);
      rt.lastAt = Date.now();
      if (status >= 500) rt.errors++;
      
      // 분당 요청수 슬라이딩 윈도우
      const nowSec = Math.floor(Date.now() / 1000);
      const lastSlot = metrics._minuteSlots[metrics._minuteSlots.length - 1];
      if (lastSlot && lastSlot.ts === nowSec) {
        lastSlot.count++;
      } else {
        metrics._minuteSlots.push({ ts: nowSec, count: 1 });
      }
      // 60초 이상 된 슬롯 제거
      const cutoff = nowSec - 60;
      while (metrics._minuteSlots.length && metrics._minuteSlots[0].ts < cutoff) {
        metrics._minuteSlots.shift();
      }
      
      // 느린 요청 경고 (3초 초과)
      if (durationMs > 3000) {
        logger.warn(`[Metrics] 느린 응답: ${routeKey} → ${Math.round(durationMs)}ms (status=${status})`);
      }
    } catch (err) {
      // 메트릭 수집 실패가 앱을 중단시키면 안 됨
    }
  });
  
  next();
}

/**
 * 에러 발생 시 최근 에러 로그에 기록하는 미들웨어
 * (글로벌 에러 핸들러 앞에 배치)
 */
function errorMetricsMiddleware(err, req, res, next) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      message: err.message,
      stack: (err.stack || '').split('\n').slice(0, 3).join('\n'),
      ip: req.ip,
      userAgent: (req.headers['user-agent'] || '').substring(0, 100),
    };
    
    metrics.recentErrors.unshift(entry);
    if (metrics.recentErrors.length > MAX_RECENT_ERRORS) {
      metrics.recentErrors.length = MAX_RECENT_ERRORS;
    }
    
    // Sentry로 전송
    captureException(err, { path: req.path, method: req.method });
  } catch (_) { /* 무시 */ }
  
  next(err);
}

/**
 * 메트릭 요약 반환 (GET /api/diag/metrics 등에서 사용)
 */
function getMetricsSummary() {
  const uptimeSec = Math.floor((Date.now() - metrics.startTime) / 1000);
  const rpm = metrics._minuteSlots.reduce((sum, s) => sum + s.count, 0);
  
  // 라우트별 응답시간 상위 10개 (느린 순)
  const slowRoutes = Object.entries(metrics.routeTimings)
    .map(([route, t]) => ({
      route,
      count: t.count,
      avgMs: Math.round(t.totalMs / t.count),
      maxMs: Math.round(t.maxMs),
      minMs: t.minMs === Infinity ? 0 : Math.round(t.minMs),
      errors: t.errors,
    }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);
  
  return {
    uptime: uptimeSec,
    totalRequests: metrics.totalRequests,
    totalErrors: metrics.totalErrors,
    clientErrors: metrics.clientErrors,
    errorRate: metrics.totalRequests > 0
      ? (metrics.totalErrors / metrics.totalRequests * 100).toFixed(2) + '%'
      : '0%',
    rpm,
    statusCodes: metrics.statusCodes,
    slowRoutes,
    recentErrors: metrics.recentErrors.slice(0, 10),
  };
}

/**
 * 메트릭 초기화
 */
function resetMetrics() {
  metrics.totalRequests = 0;
  metrics.totalErrors = 0;
  metrics.clientErrors = 0;
  metrics.statusCodes = {};
  metrics.routeTimings = {};
  metrics.recentErrors = [];
  metrics._minuteSlots = [];
  metrics.startTime = Date.now();
}

module.exports = {
  metricsMiddleware,
  errorMetricsMiddleware,
  getMetricsSummary,
  resetMetrics,
};
