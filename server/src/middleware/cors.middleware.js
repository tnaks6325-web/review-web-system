const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The dedicated Railway test frontend talks only to the isolated test API.
// Keep it out of production unless that deployment explicitly opts in.
const TEST_AUTO_LOGIN_ORIGIN = 'https://test-review-wdb-web-production.up.railway.app';
if (process.env.TEST_AUTO_LOGIN === '1') allowedOrigins.push(TEST_AUTO_LOGIN_ORIGIN);
const TEST_PR_FRONTEND_ORIGIN = /^https:\/\/test-review-wdb-web-review-web-system-pr-\d+\.up\.railway\.app$/;

// 개발환경에서는 localhost 허용
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push(
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080'
  );
}

const corsOptions = {
  origin: (origin, callback) => {
    // origin이 없는 경우 (Postman, 서버간 통신)
    // 또는 "null" 문자열 (file:// 프로토콜, sandbox iframe 등)
    if (!origin || origin === 'null') return callback(null, true);
    // 정확히 일치하는 origin
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.TEST_AUTO_LOGIN === '1' && TEST_PR_FRONTEND_ORIGIN.test(origin)) {
      return callback(null, true);
    }
    // Cloudflare Pages 서브도메인 허용 (배포별 URL: https://<hash>.review-web-system.pages.dev)
    // 해시값에 하이픈(-), 숫자, 소문자 포함 가능 (예: main, abc-123, 8f3a2b1)
    if (/^https:\/\/[a-z0-9-]+\.review-web-system\.pages\.dev$/.test(origin)) {
      return callback(null, true);
    }
    // ★ 인트라넷(inadd-system) 허용 — 작업오더 intake 제출용 (apex + 브랜치 프리뷰)
    if (/^https:\/\/([a-z0-9-]+\.)?inadd-system\.pages\.dev$/.test(origin)) {
      return callback(null, true);
    }
    // sandbox URL 개발용 허용 (프로덕션에서는 비활성)
    if (process.env.NODE_ENV !== 'production' && origin.includes('.sandbox.novita.ai')) {
      return callback(null, true);
    }
    // ★ 정상 차단 표식(결정 326) — 오류 처리기가 403 으로 답하고 이상로그를 '서버 오류(500)'로 남기지 않게 한다.
    const err = new Error(`CORS 차단: ${origin}`);
    err.status = 403;
    err.code = 'CORS_BLOCKED';
    err.corsOrigin = origin;
    callback(err);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Cache-Control·Last-Event-ID: 리뷰어 앱의 서비스워커가 실시간 알림(EventSource) 요청을 다시 보낼 때
  // 브라우저가 붙이는 헤더다. 빠지면 사전 확인이 거절돼 연결이 3초마다 재시도되는 헛요청 루프가 된다
  // (운영 실측 2026-09-28 — decision 189).
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Intake-Key', 'X-Reviewer-Token', 'Cache-Control', 'Last-Event-ID'],
  credentials: true,
  maxAge: 86400,
};

/**
 * 막힌 주소가 어떤 종류인지(결정 326) — 이상로그에 어떻게 남길지 정하는 단일 출처.
 *   'local' = 개발자 PC(localhost·127.x·사설망 IP)·브라우저 확장 → 운영 API 에 붙을 일이 없는 소음. 기록 안 함.
 *   'own'   = 우리 운영 화면 주소(review-web-system / inadd-system pages.dev) → 원래 허용돼야 한다.
 *             막혔다면 허용 설정(ALLOWED_ORIGINS) 누락 = 운영 화면이 통째로 막힌 것 → 치명으로 남긴다.
 *   'other' = 그 밖(테스트 서버·남의 사이트) → 정상 차단. 경고로만 남긴다.
 * ★ 판단이 안 서는 값(파싱 실패 등)은 'other' — 기록은 남는 쪽으로 접는다.
 */
function corsBlockKind(origin) {
  let u;
  try { u = new URL(String(origin || '')); } catch (_) { return 'other'; }
  if (/^(chrome|moz|safari-web|ms-browser)-extension:$/.test(u.protocol)) return 'local';
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'local';
  if (u.protocol === 'https:' && /(^|\.)(review-web-system|inadd-system)\.pages\.dev$/.test(h)) return 'own';
  return 'other';
}

function isCorsBlocked(err) {
  return !!err && (err.code === 'CORS_BLOCKED' || (typeof err.message === 'string' && err.message.startsWith('CORS 차단')));
}

module.exports = { corsOptions, corsBlockKind, isCorsBlocked };
