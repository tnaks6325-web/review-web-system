const express = require('express');
const router = express.Router();
const { searchByName } = require('../services/search.service');
const { buildIndexSmart, buildOneSheet } = require('../services/indexBuilder.service');
const { authMiddleware } = require('../middleware/auth.middleware');
const { emitIndexBuild } = require('../utils/sse');
const pool = require('../db/pool');
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

// ═══════════════════════════════════════════════════════════
// POST /api/index/build — 인덱스 빌드 (비동기: 즉시 응답 + 백그라운드 처리)
// 
// 55개+ 캠페인 × N개 탭을 Google Sheets API로 읽어오므로
// 동기 방식은 5분 이상 소요 → 프론트엔드 타임아웃 발생.
// 해결: 즉시 accepted 응답 반환 → 백그라운드에서 빌드 → 
//       프론트엔드는 /api/index/status 폴링으로 완료 감지.
// ═══════════════════════════════════════════════════════════
router.post('/build', authMiddleware, async (req, res, next) => {
  try {
    const { forceFullRebuild } = req.body;

    // 이미 빌드 중인지 확인 (잠금 상태)
    const { rows: lockRows } = await pool.query(
      "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD'"
    );
    if (lockRows.length > 0 && lockRows[0].is_locked) {
      const lock = lockRows[0];
      const elapsed = lock.locked_at ? Date.now() - new Date(lock.locked_at).getTime() : 0;
      // TTL(7분) 미만이면 이미 진행 중
      if (elapsed < 7 * 60 * 1000) {
        return res.json({
          ok: false,
          error: '타 사용자가 갱신중입니다. 잠시 후 다시 시도해주세요.',
          locked: true,
          elapsedSec: Math.round(elapsed / 1000),
        });
      }
    }

    // ★ 즉시 응답 반환 (accepted) — 빌드는 백그라운드에서 실행
    res.json({
      ok: true,
      success: true,
      mode: 'async',
      message: '인덱스 빌드가 시작되었습니다. 완료 시 자동으로 업데이트됩니다.',
    });

    // ★ 백그라운드에서 빌드 실행 (응답 이후 비동기 처리)
    setImmediate(async () => {
      try {
        const result = await buildIndexSmart(forceFullRebuild === true);
        console.log('[index/build] 백그라운드 빌드 완료:', JSON.stringify(result));
        // ── SSE 알림: 인덱스 빌드 완료 ──
        emitIndexBuild({
          rebuilt: result.rebuilt || 0,
          skipped: result.skipped || 0,
          errors: result.errors || 0,
          elapsed: result.elapsed || '',
          trigger: 'manual',
        });
      } catch (err) {
        console.error('[index/build] 백그라운드 빌드 실패:', err.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// Phase 4: POST /api/index/build-sheet — 특정 시트 1개만 빌드
// ═══════════════════════════════════════════════════════════
router.post('/build-sheet', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.body;
    if (!sheetId) return res.json({ error: 'sheetId 필요' });

    // 즉시 응답
    res.json({ ok: true, mode: 'async', message: `시트 ${sheetId.substring(0, 15)}... 빌드 시작` });

    // 백그라운드 빌드
    setImmediate(async () => {
      try {
        const result = await buildOneSheet(sheetId);
        console.log('[index/build-sheet] 완료:', JSON.stringify(result));
        emitIndexBuild({
          rebuilt: result.rebuilt || 0,
          skipped: result.skipped || 0,
          errors: result.errors || 0,
          elapsed: result.elapsed || '',
          trigger: 'partial',
          sheetId,
        });
      } catch (err) {
        console.error('[index/build-sheet] 실패:', err.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
