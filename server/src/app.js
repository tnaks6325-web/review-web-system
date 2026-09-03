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
const manualOrderRoutes = require('./routes/manualOrder.routes');
const diagRoutes     = require('./routes/diag.routes');
const archiveRoutes  = require('./routes/archive.routes');
const dedupeRoutes   = require('./routes/dedupe.routes');
const campaignRoutes = require('./routes/campaign.routes');
const orderRoutes    = require('./routes/order.routes');
const productRoutes  = require('./routes/product.routes');
const portalRoutes   = require('./routes/portal.routes');
const rawRoutes      = require('./routes/raw.routes');
const csRoutes       = require('./routes/cs.routes');
const mappingRoutes  = require('./routes/mapping.routes');
const participantsRoutes = require('./routes/participants.routes');
const trackBRoutes = require('./routes/trackB.routes');
const reviewEditRoutes = require('./routes/reviewEdit.routes');
const workboardConsolidationRoutes = require('./routes/workboardConsolidation.routes');

const app = express();

// ★ Railway 프록시 1홉 신뢰(레드-블루-심판, 레드 #4): 미설정이면 req.ip가 프록시 IP로 수렴해
//   전역 rate limiter(분당 120)가 전 사용자 공용 버킷이 된다(참여형 오픈 러시 정각 전면 429).
//   express-rate-limit v7의 X-Forwarded-For 검증(ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)도 함께 해소.
app.set('trust proxy', 1);

// ── Sentry 초기화 (가장 먼저) ──
initSentry(app);

// ── 미들웨어 ──
app.use(helmet());
app.use(cors(corsOptions));
// 프론트가 허용하는 10MB 이미지의 base64(JSON)는 약 13.4MB다. 10MB 본문 상한이면
// UI에서 통과한 파일이 서버에서 413으로 실패하므로 인코딩 여유만큼 맞춘다(업로드 리미터는 별도 유지).
app.use(express.json({ limit: '15mb' }));
app.use(morgan('combined'));
// 제한기에 의해 바로 끝나는 429도 관측해야 실제 제한 경로를 추적할 수 있다.
// rateLimiter 뒤에 두면 429는 finish 메트릭 자체를 남기지 못해 오류율 0%로 보인다.
app.use(metricsMiddleware);
app.use('/api/', rateLimiter);

// PR preview can be pointed at production data for verification.  Keep this
// enforcement on the server (not only in the UI) so an accidental save request
// cannot mutate the production database even when a valid admin session exists.
const readOnlyPreview = process.env.READ_ONLY_MODE === 'true';
if (readOnlyPreview) {
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Session creation must remain available; every business-data mutation is blocked.
    if (req.path === '/auth/login') return next();
    return res.status(403).json({ ok: false, error: '읽기 전용 프리뷰에서는 저장할 수 없습니다.' });
  });
}

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
// 외부모집 구매양식 관리자 수동제출(admin/master 전용) — 무인증 submit 경로와 분리
app.use('/api/manual-order', manualOrderRoutes);

// 진단/디버그/뷰어/블랙리스트/캠페인/이미지 (Section 12)
app.use('/api/diag',      diagRoutes);
app.use('/api/archive',   archiveRoutes);
app.use('/api/dedupe',    dedupeRoutes);
app.use('/api/campaign',  campaignRoutes);
app.use('/api/order',     orderRoutes);
app.use('/api/product',   productRoutes);

// 업무포털 — 거래처(광고주)별 작업 관리 (Section 13)
app.use('/api/portal',    portalRoutes);

// 리뷰어 C/S 문의창구 — 관리자 (Section 15)
app.use('/api/cs',        csRoutes);

// 구글시트 전체 RAW 미러링 (Section 14)
app.use('/api/raw',       rawRoutes);

// 명시적 컬럼 매핑 (Section 15) — 구글시트 점진 대체 keystone
app.use('/api/mapping',   mappingRoutes);
app.use('/api/participants', participantsRoutes);  // Phase 1 shadow — master 전용, 신규 테이블만
app.use('/api/trackb', trackBRoutes);              // Track B(평행 트랙) — master/광고주 스코프, 라이브 무영향

// 리뷰 이미지 수정요청 (리뷰어 → 관리자 승인 → [리뷰] 폴더 파일 교체)
app.use('/api/review-edit', reviewEditRoutes);
app.use('/api/workboard-consolidation', workboardConsolidationRoutes);

app.use('/api/viewer',    diagRoutes);
app.use('/api/image',     diagRoutes);
app.use('/api/blacklist', diagRoutes);

// 첫 무시트 구매양식 배포 구간에 원장만 남은 주문을 한 번 더 안전하게 인계한다.
// Google Sheet/GAS는 전혀 호출하지 않는다. 멀티 인스턴스 경합은 DB job lock으로 직렬화한다.
//
// ★★ 2026-08-19: 기본 OFF 로 전환(긴급). 이 잡은 "멱등"이 아니라 **os(order_submissions) 행 단위**로
//   멱등이다 — 같은 실물 주문이 여러 os 로 존재하면(무시트 경로가 `sheet_row_claims` 의
//   `(sheet_id,tab_name,dedup_key)` 유니크를 건너뛰고, `campaign_participants.order_submission_id`
//   도 유니크가 아니다) 그 하나하나가 "아직 반영 안 됨"으로 판정돼 **부팅할 때마다 빈 슬롯을 하나씩 더
//   소비**한다. 8/18~19 배포 40여 회 동안 같은 리뷰어 쌍이 규칙적으로 반복 반영되고 참여자가 정원을
//   넘긴(870/800 · 901/900) 원인이 이것이다.
// ★ 기능 자체는 살아 있다 — 필요할 때 `POST /api/diag/sheetless-worktable-recover`(adminOrMaster)로
//   사람이 실행한다. 자동 실행을 되살리려면 Railway `SHEETLESS_RECOVER_ON_BOOT=1`(중복 방어가
//   구조적으로 복구된 뒤에만).
if (process.env.SHEETLESS_RECOVER_ON_BOOT === '1') setImmediate(async () => {
  try {
    const { withJobLock } = require('./utils/jobLock');
    const { recoverUnwrittenSheetlessOrders } = require('./services/sheetlessOrder.service');
    await withJobLock('sheetless_worktable_recover', () => recoverUnwrittenSheetlessOrders({
      limit: 1000,
      by: 'startup-recovery',
    }));
    console.warn('[sheetless-worktable-recover] startup recovery ran (SHEETLESS_RECOVER_ON_BOOT=1)');
  } catch (err) {
    // 서비스 기동/사용자 요청은 막지 않고 Sentry·로그로만 남긴다.
    console.error('[sheetless-worktable-recover] startup failed:', err.message);
  }
});

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

  // AI 설정 상태 — 배포 후 GEMINI_API_KEY 주입 여부를 브라우저에서 바로 확인하기 위한 신호.
  // ★ 키 값은 절대 싣지 않는다(개수·출처 변수명·모델명만). 이 엔드포인트는 무인증 공개다.
  let ai = { gemini: 'unknown' };
  try {
    const { getGeminiStatus } = require('./services/gemini.service');
    const g = getGeminiStatus();
    ai = {
      gemini: g.configured ? 'configured' : 'not_configured',
      geminiKeys: g.keys,
      geminiKeySource: g.source,
      geminiModel: g.model,
      geminiInitialized: g.initialized,
      // 캡처 슬롯 AI 검수(현금영수증 3단계) — 키가 있어도 이게 off면 검수는 돌지 않는다
      captureVerify: process.env.CAPTURE_VERIFY !== '0' ? 'on' : 'off',
      captureVerifyMinConfidence: Number(process.env.CAPTURE_VERIFY_MIN_CONFIDENCE || 0.7),
    };
  } catch (err) {
    ai = { gemini: `error: ${err.message}` };   // 헬스체크가 죽지 않게(fail-soft)
  }

  res.json({
    ok: true,
    ts: Date.now(),
    env: process.env.NODE_ENV || 'development',
    db: dbStatus,
    dbTime,
    google: googleStatus,
    serviceAccount: saEmail,
    ai,
    version: '2.26.0-throttle-monitor',
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    sentry: isSentryEnabled() ? 'active' : 'inactive',
    /* ★★ 되돌리기 어려운 결과를 내는 킬스위치는 **화면에서 확인 가능해야 한다**.
       `SHEETLESS_RECOVER_ON_BOOT` 은 켜져 있으면 부팅마다 무시트 미반영 주문을 다시 인계하는데,
       그 잡은 os(주문원장) 행 단위로만 멱등이라 같은 실물 주문이 여러 os 로 있으면
       **배포할 때마다 작업보드 줄을 하나씩 더 만든다**(2026-08-19 중복 사고의 증폭기).
       코드는 기본 OFF 지만 환경변수는 코드에서 안 보이므로 여기서 실제 값을 드러낸다. */
    flags: {
      sheetlessRecoverOnBoot: process.env.SHEETLESS_RECOVER_ON_BOOT === '1' ? 'on' : 'off',
    },
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
