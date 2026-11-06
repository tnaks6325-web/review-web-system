'use strict';
const express = require('express');
const { reviewerSessionMiddleware } = require('../services/reviewerSession.service');
const { imageApiLimiter, imageUploadLimiter } = require('../middleware/rateLimit.middleware');

const PURCHASE_TEXT = { code: 'dual_purchase_failed', expected: '구매사진을 다시 확인해주세요.', masked: '구매사진을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' };
const REVIEW_TEXT = { code: 'dual_review_failed', expected: '리뷰 사진을 다시 확인해주세요.', masked: '리뷰 사진을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' };

function failureResponse(res, error, fallbackStatus, text = PURCHASE_TEXT) {
  const value = error && (error.status || error.statusCode);
  const status = Number.isInteger(value) && value >= 400 && value < 600 ? value
    : error && error.code === 'dual_channel_not_ready' ? 409 : fallbackStatus;
  const expected = status >= 400 && status < 500;
  const code = expected && /^[a-zA-Z0-9_]{1,80}$/.test(error && error.code || '')
    ? error.code : text.code;
  if (!expected) require('../utils/logger').logger.error({
    message: '[dual-image] 요청 처리 실패', code: error && error.code, stack: error && error.stack,
  });
  return res.status(status).json({ ok: false, code,
    error: expected ? String(error.error || error.message || text.expected).slice(0, 500) : text.masked,
  });
}

// Review evidence: only these body keys reach the service. Actor, snapshot, scope, session and
// folder are always server-derived (reviewer session from the verified JWT, the rest from the order).
const REVIEW_ROUTES = [
  ['/review-stage', 'stageReviewUpload', ['orderSubmissionId', 'sheetId', 'tabName', 'rowIndex', 'slotKey', 'imageBase64', 'mimeType', 'expectedRevision', 'replaceFileId']],
  ['/review-complete', 'completeReviewUpload', ['orderSubmissionId', 'sheetId', 'tabName', 'rowIndex', 'uploadTokens']],
];
const MAX_UPLOAD_TOKENS = 20;
function reviewStageView(result) {
  const evidence = result.evidence && typeof result.evidence === 'object' ? result.evidence : {};
  const revision = Number(evidence.evidence_revision);
  if (typeof result.fileId !== 'string' || !result.fileId || typeof result.uploadToken !== 'string' || !result.uploadToken
    || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid dual review stage response');
  return { ok: true, fileId: result.fileId, uploadToken: result.uploadToken, slotKey: String(evidence.slot_key || ''),
    channel: String(result.expectedChannel || ''), role: String(result.slotRole || ''), revision };
}
function reviewCompleteView(result) {
  if (typeof result.complete !== 'boolean') throw new Error('Invalid dual review completion response');
  const keys = (Array.isArray(result.current) ? result.current : []).map(r => r && r.slot_key).filter(k => typeof k === 'string' && k);
  const order = (Array.isArray(result.slots) ? result.slots : []).map(s => s && s.key);
  const submittedSlots = [...new Set(keys)].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  return { ok: true, complete: result.complete,
    reasons: (Array.isArray(result.reasons) ? result.reasons : []).filter(r => typeof r === 'string'), submittedSlots };
}

// The adapter authenticates HTTP callers; services recheck ownership, proof and readiness.
function createDualPurchaseImageRouter({ purchaseService, reviewService } = {}) {
  const router = express.Router();
  for (const [route, method] of [
    ['/extract', 'extractPurchase'],
    ['/artifacts', 'stagePurchaseArtifact'],
    ['/approve', 'issueBundleApproval'],
  ]) {
    router.post(route, reviewerSessionMiddleware, route === '/extract' ? imageApiLimiter : imageUploadLimiter, async (req, res) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
          return res.status(400).json({ ok: false, code: 'dual_body_invalid', error: '구매사진 요청을 다시 확인해주세요.' });
        }
        const body = { ...req.body };
        delete body.folderId;
        delete body.reviewerSession;
        const service = purchaseService || require('../services/dualPurchaseSubmission.service');
        const result = await service[method]({ body, reviewerSession: req.reviewer });
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid dual image service response');
        if (result.ok === false || result.error) return failureResponse(res, result, 409);
        return res.json(route === '/artifacts' ? { ok: true, artifact: result } : { ...result, ok: true });
      } catch (error) { return failureResponse(res, error, 500); }
    });
  }
  for (const [route, method, keys] of REVIEW_ROUTES) {
    router.post(route, reviewerSessionMiddleware, imageUploadLimiter, async (req, res) => {
      try {
        const raw = req.body;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
          || (route === '/review-complete' && (!Array.isArray(raw.uploadTokens) || raw.uploadTokens.length > MAX_UPLOAD_TOKENS
            || !raw.uploadTokens.every(t => typeof t === 'string')))) {
          return res.status(400).json({ ok: false, code: 'dual_body_invalid', error: '리뷰 사진 요청을 다시 확인해주세요.' });
        }
        const body = {};
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(raw, key)) body[key] = raw[key];
        const service = reviewService || require('../services/dualChannelReview.service');
        const result = await service[method]({ body, reviewerSession: req.reviewer });
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid dual review service response');
        if (result.ok === false || result.error) return failureResponse(res, result, 409, REVIEW_TEXT);
        return res.json(route === '/review-stage' ? reviewStageView(result) : reviewCompleteView(result));
      } catch (error) { return failureResponse(res, error, 500, REVIEW_TEXT); }
    });
  }
  return router;
}

module.exports = { createDualPurchaseImageRouter, sendDualChannelHttpFailure: failureResponse };
