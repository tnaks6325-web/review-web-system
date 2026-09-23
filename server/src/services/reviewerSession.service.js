const jwt = require('jsonwebtoken');

const ISSUER = 'review-web-system';
const AUDIENCE = 'reviewer-app';
const SCOPE = 'reviewer_session';

function issueReviewerSession({ ownerReviewerId, loginName, loginPhone8, loginKind = 'self' }) {
  if (!ownerReviewerId) throw new Error('리뷰어 소유자 ID가 없어 세션을 발급할 수 없습니다.');
  return jwt.sign({
    scope: SCOPE,
    ownerReviewerId: String(ownerReviewerId),
    loginName: String(loginName || '').trim(),
    loginPhone8: String(loginPhone8 || '').replace(/\D/g, '').slice(-8),
    loginKind: loginKind === 'sub' ? 'sub' : 'self',
  }, process.env.JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: process.env.REVIEWER_SESSION_EXPIRES_IN || '12h',
  });
}

function verifyReviewerSession(token) {
  const payload = jwt.verify(String(token || ''), process.env.JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload || payload.scope !== SCOPE || !payload.ownerReviewerId) {
    const err = new Error('유효하지 않은 리뷰어 세션입니다.');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

function reviewerSessionMiddleware(req, res, next) {
  const explicit = req.headers['x-reviewer-token'];
  const auth = req.headers.authorization || '';
  const fallback = /^Bearer\s+(.+)$/i.exec(auth);
  const token = explicit || (fallback && fallback[1]);
  if (!token) return res.status(401).json({ ok: false, code: 'REVIEWER_AUTH_REQUIRED', error: '리뷰어 로그인이 필요합니다.' });
  try {
    req.reviewer = verifyReviewerSession(token);
    next();
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      ok: false,
      code: expired ? 'REVIEWER_SESSION_EXPIRED' : 'REVIEWER_AUTH_INVALID',
      error: expired ? '로그인 시간이 만료되었습니다. 다시 로그인해주세요.' : '유효하지 않은 리뷰어 로그인입니다.',
    });
  }
}

module.exports = {
  issueReviewerSession,
  verifyReviewerSession,
  reviewerSessionMiddleware,
  REVIEWER_SESSION_ISSUER: ISSUER,
  REVIEWER_SESSION_AUDIENCE: AUDIENCE,
};
