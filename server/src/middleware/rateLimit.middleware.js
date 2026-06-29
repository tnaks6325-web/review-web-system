const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// ★ max: 환경변수로 조정 가능(기본 600/분). trust proxy=1 적용으로 IP별 버킷이
//    실제 클라이언트 기준이 되지만, 모바일 CGNAT(통신사 NAT)로 다수가 같은 공인
//    IP를 공유할 수 있어 동시 구매오픈 대비 여유 있게 상향.
const rateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1분
  max: parseInt(process.env.RATE_LIMIT_MAX || '600', 10),  // 분당 요청 (기본 600)
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/index/'),
});

// 리뷰어 등록은 더 엄격한 제한
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '등록 요청이 너무 많습니다.' },
});

// ── 이미지 API 전용 rate limiter (Gemini/Drive 비용 보호) ──
// 관리자 로그인 시 skip, 비로그인은 분당 10회 제한
const imageApiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1분
  max: 10,              // 분당 10회 (비로그인 사용자)
  message: { ok: false, error: '이미지 분석 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // JWT 토큰이 있고 유효하면 rate limit 건너뛰기
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return false;
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      return true; // 인증된 관리자 → 제한 없음
    } catch (_) {
      return false; // 토큰 무효 → 제한 적용
    }
  },
});

module.exports = { rateLimiter, registerLimiter, imageApiLimiter };
