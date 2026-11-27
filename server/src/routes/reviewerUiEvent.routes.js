'use strict';
/* 결정 425 — POST /api/reviewer/ui-event : 리뷰어 화면 사건 횟수(지금은 「사진을 다시 넣어 주세요」 안내가 뜬 횟수 하나).
 *   로그인 없이 받는다(직접 링크·공고 틀 어디서든 · 누가 보냈는지는 받지도 남기지도 않는다).
 *   - 허용 목록(reviewerUiEvents.service UI_EVENTS) 밖 = 400 · 본문이 크면(512바이트 초과) = 413 · 받으면 204(기록은 기다리지 않음).
 *   - 인터넷 주소별 분당 20회(diag client-error 와 같은 express-rate-limit 꼴 · 주소는 세기에만 쓰고 저장하지 않는다).
 *   화면은 응답을 읽지 않는다 — 어떤 실패도 화면을 막지 않는다(옛 서버의 404 도 조용히). */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { clientIp } = require('../middleware/rateLimit.middleware');
const { normalizeUiEvent, recordUiEvent } = require('../services/reviewerUiEvents.service');

const MAX_BODY_BYTES = 512;
const makeLimiter = () => rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'uie:' + clientIp(req),
  message: { ok: false, error: '요청이 너무 잦습니다.' },
});

function createReviewerUiEventRouter(deps = {}) {
  const router = express.Router();
  const uiEventLimiter = makeLimiter();
  const record = deps.recordUiEvent || recordUiEvent;
  router.post('/ui-event', uiEventLimiter, (req, res) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY_BYTES) return res.status(413).json({ ok: false });
    const row = normalizeUiEvent(req.body);
    if (!row) return res.status(400).json({ ok: false });
    try { const p = record(row, deps.pool); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) { /* 기록 실패는 응답과 무관 */ }
    return res.status(204).end();
  });
  return router;
}

module.exports = createReviewerUiEventRouter();
module.exports.createReviewerUiEventRouter = createReviewerUiEventRouter;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
