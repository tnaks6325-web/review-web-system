const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { isLoginSessionToken } = require('./auth.middleware');

// ── 전역 제한 = "사람별 통" + "인터넷 주소별 상한" 두 겹 (decision 188, 2026-09-28) ──
// ★ 종전엔 인터넷 주소(IP) 하나당 분당 120 한 통이었다. 사무실은 직원 전원이 한 주소를 쓰고,
//   통신사는 서로 모르는 리뷰어 여럿에게 한 주소를 주므로(공유 IP), 남의 요청 때문에 내 편집·조회가
//   "요청이 너무 많습니다"로 막혔다(실측: 사무실 IP 43초 54건 중 19건 거절, 작업보드 편집 거부).
// ★ 사람을 알아볼 수 있으면 그 사람 통으로 센다:
//   ① 서버가 서명을 검증한 직원·광고주 토큰(Authorization) → 사람별 (직원 화면은 요청이 많아 넉넉히)
//   ② 서버가 서명을 검증한 리뷰어 로그인(X-Reviewer-Token 또는 Bearer) → 리뷰어별
//   ③ 요청에 적힌 연락처 뒤8자리(phone8) → "주소+번호"별 (검증 안 된 값이라 아래 ④ 상한이 함께 막는다)
//   ④ 그 외 → 주소별(종전과 같다)
// ★★ 검증 안 된 신원(③④)은 인터넷 주소별 상한을 한 번 더 받는다 — 번호를 바꿔 가며 통을 늘리는
//   무차별 요청을 막기 위해서다(완화 금지). 서명 검증된 직원·리뷰어는 이 상한에서 뺀다
//   (그들을 주소로 묶으면 원래 문제가 되살아난다).
const RL_WINDOW_MS = 60 * 1000;
const RL_STAFF_MAX = Number(process.env.RL_STAFF_MAX) || 300;       // 직원·광고주 1명당
const RL_REVIEWER_MAX = Number(process.env.RL_REVIEWER_MAX) || 180; // 리뷰어 1명당
const RL_ANON_MAX = Number(process.env.RL_ANON_MAX) || 120;         // 주소별(종전 값)
const RL_IP_CEILING = Number(process.env.RL_IP_CEILING) || 600;     // 검증 안 된 요청의 주소별 상한
const RL_MESSAGE = { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' };

function _rlSkip(req) {
  // ★ app.use('/api/', …) 마운트 내부에선 req.path가 마운트 경로가 벗겨진 값('/index/…')이라
  //   '/api/…' 프리픽스 비교는 절대 매치되지 않았다(심판 실측 — 기존 skip은 dead code).
  //   baseUrl+path로 전체 경로를 복원해 판정: ① /api/index/* (원 주석 의도 복원),
  //   ② 참여형 목록 폴링(GET /api/campaign/list — 5초 서버캐시·무PII·화이트리스트라 저비용).
  const p = (req.baseUrl || '') + (req.path || '');
  return p.startsWith('/api/index/')
      || (req.method === 'GET' && p === '/api/campaign/list');
}

// ★★ 실제 사용자 주소 — Railway 는 앞단 프록시를 여러 겹 거쳐 req.ip 가 프록시 주소(152.233.x)로
//   모인다(운영 로그 실측 2026-09-28: 모든 요청이 소수의 프록시 주소로 기록). 그래서 종전 "주소별
//   120" 은 사실상 **전 사용자 공용 통**이었다. Railway 는 사용자 주소를 X-Real-IP 로 준다(공식 문서).
//   형식이 주소가 아니면 req.ip 로 접는다. 끄는 스위치 RL_TRUST_X_REAL_IP=0.
function clientIp(req) {
  if (process.env.RL_TRUST_X_REAL_IP !== '0') {
    const v = String(req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (/^[0-9a-fA-F:.]{3,45}$/.test(v)) return v;
  }
  return req.ip;
}

function _verify(token) {
  if (!token || !process.env.JWT_SECRET) return null;
  try { return jwt.verify(String(token), process.env.JWT_SECRET); } catch (_) { return null; }
}

/** 요청의 신원을 한 번만 판정해 req 에 기억한다. { kind, key, verified } */
function rateIdentity(req) {
  if (req._rlIdentity) return req._rlIdentity;
  let id = null;
  const auth = req.headers['authorization'] || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const bearerPayload = bearer ? _verify(bearer[1]) : null;
  const reviewerPayload = _verify(req.headers['x-reviewer-token'])
    || (bearerPayload && bearerPayload.scope === 'reviewer_session' ? bearerPayload : null);
  if (bearerPayload && bearerPayload.scope !== 'reviewer_session') {
    // 서명된 고유 ID를 이름보다 먼저 쓴다 — 브랜드·광고주 이름은 겹칠 수 있다(같은 이름 = 같은 통 금지).
    const pl = bearerPayload;
    const who = pl.brand_id != null ? `b${pl.brand_id}`
      : pl.advertiser_id != null ? `a${pl.advertiser_id}:${pl.via || ''}:${pl.name || ''}`
      : (pl.id || pl.iu || pl.name || pl.username || '');
    if (who) id = { kind: 'staff', key: `s:${pl.role || ''}:${who}`, verified: true };
  }
  if (!id && reviewerPayload && reviewerPayload.scope === 'reviewer_session' && reviewerPayload.ownerReviewerId) {
    id = { kind: 'reviewer', key: `r:${reviewerPayload.ownerReviewerId}`, verified: true };
  }
  if (!id) {
    const raw = (req.query && req.query.phone8) || (req.body && typeof req.body === 'object' && req.body.phone8) || '';
    const p8 = String(raw || '').replace(/\D/g, '').slice(-8);
    id = p8.length === 8
      ? { kind: 'phone', key: `p:${clientIp(req)}:${p8}`, verified: false }
      : { kind: 'anon', key: `i:${clientIp(req)}`, verified: false };
  }
  req._rlIdentity = id;
  return id;
}

const identityLimiter = rateLimit({
  windowMs: RL_WINDOW_MS,
  max: (req) => {
    const k = rateIdentity(req).kind;
    return k === 'staff' ? RL_STAFF_MAX : (k === 'reviewer' || k === 'phone') ? RL_REVIEWER_MAX : RL_ANON_MAX;
  },
  keyGenerator: (req) => rateIdentity(req).key,
  message: RL_MESSAGE,
  standardHeaders: true,
  legacyHeaders: false,
  skip: _rlSkip,
});

const ipCeilingLimiter = rateLimit({
  windowMs: RL_WINDOW_MS,
  max: RL_IP_CEILING,
  keyGenerator: (req) => `ipc:${clientIp(req)}`,
  message: RL_MESSAGE,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => _rlSkip(req) || rateIdentity(req).verified,
});

/** 전역 제한 — 주소별 상한을 먼저 보고, 통과하면 사람별 통을 본다. */
function rateLimiter(req, res, next) {
  ipCeilingLimiter(req, res, (err) => {
    if (err) return next(err);
    identityLimiter(req, res, next);
  });
}

// 리뷰어 등록은 더 엄격한 제한
const registerLimiter = rateLimit({
  keyGenerator: (req) => clientIp(req),   // 실제 사용자 주소(프록시 주소 공용 통 방지)
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '등록 요청이 너무 많습니다.' },
});

// ── 인트라넷 SSO 로그인(무인증 자격 프록시) 전용 — 리뷰서버가 인트라넷 대상
//    크리덴셜 스터핑 오라클/프록시가 되는 것 방지(전역 120/분 대비 강한 10/분).
const intranetLoginLimiter = rateLimit({
  keyGenerator: (req) => clientIp(req),   // 실제 사용자 주소(프록시 주소 공용 통 방지)
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── 이미지 API 전용 rate limiter (Gemini/Drive 비용 보호) ──
// 관리자 로그인 시 skip, 비로그인은 분당 10회 제한
const imageApiLimiter = rateLimit({
  keyGenerator: (req) => clientIp(req),   // 실제 사용자 주소(프록시 주소 공용 통 방지)
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
      // 로그인 세션 토큰만 면제 — 무인증으로 받는 추출 증명·리뷰어 세션으로 제한을 풀지 못하게(결정 201).
      return isLoginSessionToken(jwt.verify(token, process.env.JWT_SECRET)); // 인증된 관리자 → 제한 없음
    } catch (_) {
      return false; // 토큰 무효 → 제한 적용
    }
  },
});

// ── 구매 캡처 업로드 전용 ──────────────────────────────────────────────────────
// ★★ AI 분석(image-extract)과 **버킷을 나눈다**: 둘이 같은 통(분당 10)을 쓰면 카드 5장짜리
//   다건 제출이 "추출 5 + 업로드 5 = 정확히 10"이라 재시도 한 번에 429 로 밀리고,
//   그때 **유실되는 것은 정산 증빙(구매 캡처)** 이다. 업로드는 AI 콜이 아니라 Drive 저장이라
//   비용 성격도 다르다. 무제한이 아니라 통만 분리한다(남용 방어 유지).
const imageUploadLimiter = rateLimit({
  keyGenerator: (req) => clientIp(req),   // 실제 사용자 주소(프록시 주소 공용 통 방지)
  windowMs: 60 * 1000,  // 1분
  max: 30,              // 분당 30회 (비로그인 리뷰어 — 다건 제출 + 재시도 여유)
  message: { ok: false, error: '이미지 업로드 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return false;
    try { return isLoginSessionToken(jwt.verify(token, process.env.JWT_SECRET)); } catch (_) { return false; }
  },
});

// ── 광고주 접속 링크 교환(무인증 공개 경로) 전용 — 토큰 브루트포스 완화. IP당 분당 30회. ──
const advertiserLinkLimiter = rateLimit({
  keyGenerator: (req) => clientIp(req),   // 실제 사용자 주소(프록시 주소 공용 통 방지)
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── 리뷰어 공고수정 토큰 발급(무인증 공개 경로) 전용 — 허용명단 phone8 브루트포스 완화.
//    발급 자체가 verifyReviewer(이름+phone8) + active 명단 이중 게이트지만, 오라클/스터핑 억제. ──
const campaignTokenLimiter = rateLimit({
  keyGenerator: (req) => clientIp(req),   // 실제 사용자 주소(프록시 주소 공용 통 방지)
  windowMs: 60 * 1000,
  max: 20,
  message: { ok: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { rateLimiter, rateIdentity, clientIp, identityLimiter, ipCeilingLimiter, registerLimiter, imageApiLimiter, imageUploadLimiter, intranetLoginLimiter, advertiserLinkLimiter, campaignTokenLimiter };
