'use strict';
const express = require('express');
const { reviewerSessionMiddleware } = require('../services/reviewerSession.service');
const { imageApiLimiter, imageUploadLimiter } = require('../middleware/rateLimit.middleware');

function failureResponse(res, error, fallbackStatus) {
  const value = error && (error.status || error.statusCode);
  const status = Number.isInteger(value) && value >= 400 && value < 600 ? value
    : error && error.code === 'dual_channel_not_ready' ? 409 : fallbackStatus;
  const expected = status >= 400 && status < 500;
  const code = expected && /^[a-zA-Z0-9_]{1,80}$/.test(error && error.code || '')
    ? error.code : 'dual_purchase_failed';
  if (!expected) require('../utils/logger').logger.error({
    message: '[dual-image] 요청 처리 실패', code: error && error.code, stack: error && error.stack,
  });
  return res.status(status).json({ ok: false, code,
    error: expected ? String(error.error || error.message || '구매사진을 다시 확인해주세요.').slice(0, 500)
      : '구매사진을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.',
  });
}

// The adapter authenticates HTTP callers; services recheck ownership, proof and readiness.
function createDualPurchaseImageRouter({ purchaseService } = {}) {
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
  return router;
}

module.exports = { createDualPurchaseImageRouter, sendDualChannelHttpFailure: failureResponse };
