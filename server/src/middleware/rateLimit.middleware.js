const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1분
  max: 120,             // 분당 120 요청
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // ★ app.use('/api/', …) 마운트 내부에선 req.path가 마운트 경로가 벗겨진 값('/index/…')이라
    //   '/api/…' 프리픽스 비교는 절대 매치되지 않았다(심판 실측 — 기존 skip은 dead code).
    //   baseUrl+path로 전체 경로를 복원해 판정: ① /api/index/* (원 주석 의도 복원),
    //   ② 참여형 목록 폴링(GET /api/campaign/list — 5초 서버캐시·무PII·화이트리스트라 저비용).
    const p = (req.baseUrl || '') + (req.path || '');
    return p.startsWith('/api/index/')
        || (req.method === 'GET' && p === '/api/campaign/list');
  },
});

// 리뷰어 등록은 더 엄격한 제한
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '등록 요청이 너무 많습니다.' },
});

// ── 인트라넷 SSO 로그인(무인증 자격 프록시) 전용 — 리뷰서버가 인트라넷 대상
//    크리덴셜 스터핑 오라클/프록시가 되는 것 방지(전역 120/분 대비 강한 10/분).
const intranetLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
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

// ── 광고주 접속 링크 교환(무인증 공개 경로) 전용 — 토큰 브루트포스 완화. IP당 분당 30회. ──
const advertiserLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── 리뷰어 공고수정 토큰 발급(무인증 공개 경로) 전용 — 허용명단 phone8 브루트포스 완화.
//    발급 자체가 verifyReviewer(이름+phone8) + active 명단 이중 게이트지만, 오라클/스터핑 억제. ──
const campaignTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { ok: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { rateLimiter, registerLimiter, imageApiLimiter, intranetLoginLimiter, advertiserLinkLimiter, campaignTokenLimiter };
