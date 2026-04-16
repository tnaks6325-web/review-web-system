const rateLimit = require('express-rate-limit');

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1분
  max: 120,             // 분당 120 요청
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

module.exports = { rateLimiter, registerLimiter };
