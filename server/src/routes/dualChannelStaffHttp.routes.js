'use strict';
const express = require('express');
const { authMiddleware, internalOnlyMiddleware } = require('../middleware/auth.middleware');
const { sendDualChannelHttpFailure } = require('./dualChannelHttp.routes');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Internal workdesk editing already permits master/admin/staff across work scopes.
function createDualStaffPurchaseRouter({ staffService, artifactService, db } = {}) {
  const router = express.Router();
  const routes = [
    { method: 'post', path: '/identity-review', operation: 'review', call: 'resolveBundleIdentityReview',
      fields: ['orderSubmissionId', 'expectedBundleHash', 'expectedArtifactRevisions', 'decision', 'note'] },
    { method: 'patch', path: '/amount', operation: 'payment', call: 'amendBundlePurchaseAmount',
      fields: ['orderSubmissionId', 'channel', 'paidAmount', 'expectedRevision'] },
    { method: 'post', path: '/artifact-replace', operation: 'review', call: 'replacePurchaseArtifact',
      fields: ['orderSubmissionId', 'channel', 'role', 'expectedArtifactId', 'expectedRevision', 'imageBase64', 'mimeType', 'sourceArtifactId'] },
  ];
  for (const route of routes) {
    router[route.method](route.path, authMiddleware, internalOnlyMiddleware, async (req, res) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
            || typeof req.body.orderSubmissionId !== 'string' || !UUID_RE.test(req.body.orderSubmissionId)) {
          return res.status(400).json({ ok: false, code: 'dual_order_invalid', error: '구매 기록을 다시 확인해주세요.' });
        }
        require('../services/dualChannelRuntime.service').assertDualChannelReady(route.operation);
        const input = Object.fromEntries(route.fields.filter(field => Object.hasOwn(req.body, field)).map(field => [field, req.body[field]]));
        input.actor = String(req.admin.username || req.admin.name || req.admin.id || req.admin.role);
        let service;
        if (route.call === 'replacePurchaseArtifact') {
          service = artifactService || require('../services/dualPurchaseArtifacts.service');
        } else {
          service = staffService || require('../services/dualChannelStaffReview.service');
          input.db = db || require('../db/pool');
        }
        const result = await service[route.call](input);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid dual staff service response');
        if (result.ok === false || result.error) return sendDualChannelHttpFailure(res, result, 409);
        return res.json(route.call === 'replacePurchaseArtifact' ? { ok: true, artifact: result } : { ...result, ok: true });
      } catch (error) { return sendDualChannelHttpFailure(res, error, 500); }
    });
  }
  return router;
}
module.exports = { createDualStaffPurchaseRouter };
