const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
require('dotenv').config();

const { corsOptions }     = require('./middleware/cors.middleware');
const { errorHandler }    = require('./middleware/error.middleware');
const { rateLimiter }     = require('./middleware/rateLimit.middleware');
const { metricsMiddleware, errorMetricsMiddleware, getMetricsSummary } = require('./middleware/metrics.middleware');
const { initSentry, isSentryEnabled } = require('./utils/sentry');
const { getStatus: getSSEStatus } = require('./utils/sse');

// 라우터
const indexRoutes    = require('./routes/index.routes');
const tabRoutes      = require('./routes/tabconfig.routes');
const reviewerRoutes = require('./routes/reviewer.routes');
const adminRoutes    = require('./routes/admin.routes');
const driveRoutes    = require('./routes/drive.routes');
const shortRoutes    = require('./routes/shortlink.routes');
const memoRoutes     = require('./routes/memo.routes');
const paymentRoutes  = require('./routes/payment.routes');
const submitRoutes   = require('./routes/submit.routes');
const diagRoutes     = require('./routes/diag.routes');
const archiveRoutes  = require('./routes/archive.routes');
const dedupeRoutes   = require('./routes/dedupe.routes');

const app = express();

// ── Sentry 초기화 (가장 먼저) ──
initSentry(app);

// ── 미들웨어 ──
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));
app.use('/api/', rateLimiter);
app.use(metricsMiddleware);  // API 메트릭 수집

// ── 라우터 등록 ──
// 검색/인덱스 (Section 5)
app.use('/api/search',    indexRoutes);
app.use('/api/index',     indexRoutes);

// 탭 설정 (Section 6)
app.use('/api/tab',       tabRoutes);

// 리뷰어 관리 (Section 7)
app.use('/api/reviewer',  reviewerRoutes);

// 관리자 인증 + Staff (Section 8)
app.use('/api/admin',     adminRoutes);

// Drive 폴더 (Section 9)
app.use('/api/drive',     driveRoutes);

// 단축URL (Section 10)
app.use('/api/short',     shortRoutes);

// 메모 (Section 10)
app.use('/api/memo',      memoRoutes);

// 입금처리 (Section 11)
app.use('/api/payment',   paymentRoutes);

// 리뷰제출 + 구매양식 (Section 5/12)
app.use('/api/submit',    submitRoutes);

// 진단/디버그/뷰어/블랙리스트/캠페인/이미지 (Section 12)
app.use('/api/diag',      diagRoutes);
app.use('/api/archive',   archiveRoutes);
app.use('/api/dedupe',    dedupeRoutes);
app.use('/api/viewer',    diagRoutes);
app.use('/api/image',     diagRoutes);
app.use('/api/blacklist', diagRoutes);

// ── 단축링크 OG 프리뷰 (카카오톡/SNS 공유용) ──
// /r/:code → 크롤러에게 동적 OG HTML, 일반 브라우저에게 프론트엔드 리다이렉트
app.get('/r/:code', (req, res, next) => {
  // shortRoutes의 /og/:code 핸들러로 포워딩
  req.url = '/og/' + req.params.code;
  shortRoutes(req, res, next);
});

// ── 헬스체크 ──
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbTime = null;
  try {
    const pool = require('./db/pool');
    const result = await pool.query('SELECT NOW() AS now');
    dbStatus = 'connected';
    dbTime = result.rows[0]?.now;
  } catch (err) {
    dbStatus = `error: ${err.message}`;
  }

  const googleStatus = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'configured' : 'not_configured';
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '(미설정)';

  res.json({
    ok: true,
    ts: Date.now(),
    env: process.env.NODE_ENV || 'development',
    db: dbStatus,
    dbTime,
    google: googleStatus,
    serviceAccount: saEmail,
    version: '2.19.1-bigo-debug',
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    sentry: isSentryEnabled() ? 'active' : 'inactive',
    sse: {
      connections: getSSEStatus().activeConnections,
    },
    metrics: {
      totalRequests: getMetricsSummary().totalRequests,
      errorRate: getMetricsSummary().errorRate,
      rpm: getMetricsSummary().rpm,
    },
    routes: {
      search: '/api/search?query=',
      index: '/api/index/status',
      tab: '/api/tab/config',
      reviewer: '/api/reviewer/*',
      admin: '/api/admin/login',
      drive: '/api/drive/*',
      short: '/api/short/*',
      memo: '/api/memo',
      payment: '/api/payment/targets',
      submit: '/api/submit/*',
      diag: '/api/diag/*',
    }
  });
});

// ── 에러 메트릭 수집 (Sentry + 자체 로그) ──
app.use(errorMetricsMiddleware);

// ── 글로벌 에러 핸들러 ──
app.use(errorHandler);

module.exports = app;
