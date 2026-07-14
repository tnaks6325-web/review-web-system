const jwt = require('jsonwebtoken');

/**
 * JWT 토큰 검증 미들웨어
 * Authorization: Bearer <token> 헤더에서 토큰 추출
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // SSE 등 EventSource는 커스텀 헤더 불가 → 쿼리 파라미터 fallback
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: '인증이 필요합니다.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인하세요.' });
      }
      return res.status(401).json({ error: '유효하지 않은 인증 토큰입니다.' });
    }
    // ★ 인트라넷 SSO 토큰(via:'intranet')은 Track B 통합작업대(/api/trackb/*) 전용.
    //   외부(inadd) 발급 신원이 Track A의 authMiddleware-only 라우트(탭설정 리셋·메모 등
    //   파괴적 쓰기)에 도달하는 폭발반경을 원천 차단(폐쇄 기본). 기존 토큰(via 없음)은 무영향.
    //   경로 판정은 baseUrl+path(마운트 스트리핑 함정 회피 — 전역 리미터 skip과 동일 규칙).
    if (decoded && decoded.via === 'intranet') {
      const p = (req.baseUrl || '') + (req.path || '');
      if (!(p === '/api/trackb' || p.startsWith('/api/trackb/'))) {
        return res.status(403).json({ error: '인트라넷 연동 계정은 통합 작업대(Track B)에서만 사용할 수 있습니다.' });
      }
    }
    req.admin = decoded; // { name, role, iat, exp }
    next();
  });
}

/** 마스터 전용 라우트 */
function masterOnlyMiddleware(req, res, next) {
  if (!req.admin || req.admin.role !== 'master') {
    return res.status(403).json({ error: '마스터 권한이 필요합니다.' });
  }
  next();
}

/** 관리자(admin) 또는 마스터(master) 전용 — staff(영업담당자) 차단 */
function adminOrMasterMiddleware(req, res, next) {
  if (!req.admin || !['admin', 'master'].includes(req.admin.role)) {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  }
  next();
}

/** 인애드 내부 담당자 전용 — master/admin/staff 허용, advertiser(광고주) 차단 */
function internalOnlyMiddleware(req, res, next) {
  if (!req.admin || !['master', 'admin', 'staff'].includes(req.admin.role)) {
    return res.status(403).json({ error: '내부 담당자 권한이 필요합니다.' });
  }
  next();
}

module.exports = { authMiddleware, masterOnlyMiddleware, adminOrMasterMiddleware, internalOnlyMiddleware };
