const express = require('express');
const router = express.Router();
const { searchByName } = require('../services/search.service');
const { verifyReviewerSession } = require('../services/reviewerSession.service');
const reviewerIdentity = require('../services/reviewerIdentity.service');

// ═══════════════════════════════════════════════════════════
// GET /api/search — 이름/전화번호 검색 (GAS: searchAll)
// ═══════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    const { query, phone8, includeSubmitted, ownerScope } = req.query;
    let ownerReviewerId = null;
    let ownerPhone8s = null;
    let scopedQuery = query;
    let scopedPhone8 = phone8;
    let strictPhoneScope = false;
    let participantIdentityId = null;
    let restrictParticipant = false;
    if (ownerScope === '1' || ownerScope === 'true') {
      const token = req.headers['x-reviewer-token'];
      if (!token) {
        return res.status(401).json({ ok: false, code: 'REVIEWER_AUTH_REQUIRED', error: '리뷰어 로그인이 필요합니다.' });
      }
      try {
        const session = verifyReviewerSession(token);
        const scope = await reviewerIdentity.getOwnerScopeByReviewerId(session.ownerReviewerId);
        if (!scope.ownerReviewerId) {
          return res.status(401).json({ ok: false, code: 'REVIEWER_AUTH_INVALID', error: '리뷰어 정보를 찾을 수 없습니다.' });
        }
        const loginPhone8 = String(session.loginPhone8 || '').replace(/\D/g, '').slice(-8);
        if (session.loginKind === 'sub') {
          if (loginPhone8.length !== 8) {
            return res.status(401).json({ ok: false, code: 'REVIEWER_AUTH_INVALID', error: '리뷰어 정보를 찾을 수 없습니다.' });
          }
          // 타계정 로그인은 본계정 UUID나 형제 타계정 번호로 확장하지 않는다.
          // 요청 query/phone8도 신뢰하지 않고 토큰의 로그인 번호 하나로만 검색한다.
          const identity = await reviewerIdentity.resolveParticipantIdentity({
            ownerReviewerId: scope.ownerReviewerId,
            participantPhone8: loginPhone8,
          });
          ownerReviewerId = scope.ownerReviewerId;
          ownerPhone8s = [loginPhone8];
          participantIdentityId = identity && identity.id || null;
          restrictParticipant = true;
          scopedQuery = '';
          scopedPhone8 = loginPhone8;
          strictPhoneScope = true;
        } else {
          ownerReviewerId = scope.ownerReviewerId;
          ownerPhone8s = scope.phone8s;
        }
      } catch (err) {
        const expired = err && err.name === 'TokenExpiredError';
        return res.status(401).json({
          ok: false,
          code: expired ? 'REVIEWER_SESSION_EXPIRED' : 'REVIEWER_AUTH_INVALID',
          error: expired ? '로그인 시간이 만료되었습니다. 다시 로그인해주세요.' : '유효하지 않은 리뷰어 로그인입니다.',
        });
      }
    }
    const result = await searchByName(scopedQuery, scopedPhone8, {
      // 리뷰어 홈 제출대기/제출완료 탭용 — 제출 완료 행도 포함해 반환
      includeSubmitted: includeSubmitted === '1' || includeSubmitted === 'true',
      ownerReviewerId,
      ownerPhone8s,
      strictPhoneScope,
      participantIdentityId,
      restrictParticipant,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/search/debug(= /api/index/debug) 은 2026-10-05 제거 — 결정 186 103번(옛 리뷰제출 화면의 열 수 없는 진단 창 전용 · 9/2 이후 호출 0).

// POST /api/index/build · /build-sheet(= /api/search/build·build-sheet — 구글시트를 읽어 색인을 다시 만드는 수동 버튼)은
// 2026-10-22 제거 — 결정 273 · 결정 186 88번. 무시트 작업의 색인은 작업표에서 바로 만든다(sheetlessLedger).

module.exports = router;
