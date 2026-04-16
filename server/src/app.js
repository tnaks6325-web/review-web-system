const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
require('dotenv').config();

const { corsOptions }     = require('./middleware/cors.middleware');
const { errorHandler }    = require('./middleware/error.middleware');
const { rateLimiter }     = require('./middleware/rateLimit.middleware');

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

const app = express();

// ── 미들웨어 ──
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));
app.use('/api/', rateLimiter);

// ── 라우터 등록 ──
app.use('/api/search',    indexRoutes);
app.use('/api/index',     indexRoutes);
app.use('/api/tab',       tabRoutes);
app.use('/api/reviewer',  reviewerRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/drive',     driveRoutes);
app.use('/api/short',     shortRoutes);
app.use('/api/memo',      memoRoutes);
app.use('/api/payment',   paymentRoutes);
app.use('/api/submit',    submitRoutes);
app.use('/api/diag',      diagRoutes);
// 뷰어/이미지/블랙리스트/캠페인 — diag 라우터에 통합
app.use('/api/viewer',    diagRoutes);
app.use('/api/image',     diagRoutes);
app.use('/api/blacklist', diagRoutes);

// ── 헬스체크 ──
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    const pool = require('./db/pool');
    const result = await pool.query('SELECT NOW() AS now');
    dbStatus = 'connected';
  } catch (err) {
    dbStatus = `error: ${err.message}`;
  }

  res.json({
    ok: true,
    ts: Date.now(),
    env: process.env.NODE_ENV || 'development',
    db: dbStatus,
    version: '1.0.0',
  });
});

// ── 글로벌 에러 핸들러 ──
app.use(errorHandler);

module.exports = app;
