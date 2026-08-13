const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The dedicated Railway test frontend talks only to the isolated test API.
// Keep it out of production unless that deployment explicitly opts in.
const TEST_AUTO_LOGIN_ORIGIN = 'https://test-review-wdb-web-production.up.railway.app';
if (process.env.TEST_AUTO_LOGIN === '1') allowedOrigins.push(TEST_AUTO_LOGIN_ORIGIN);

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
    callback(new Error(`CORS 차단: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Intake-Key'],
  credentials: true,
  maxAge: 86400,
};

module.exports = { corsOptions };
