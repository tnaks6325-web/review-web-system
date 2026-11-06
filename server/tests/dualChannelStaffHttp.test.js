'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const runtime = require('../src/services/dualChannelRuntime.service');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');
const { createDualStaffPurchaseRouter } = require('../src/routes/dualChannelStaffHttp.routes');
const orderId = '00000000-0000-0000-0000-000000000011';

test('actual staff HTTP rejects untrusted roles and body readiness, then forwards allowlisted fields with signed actor', async () => {
  const calls = [];
  const service = Object.fromEntries(['resolveBundleIdentityReview', 'amendBundlePurchaseAmount'].map(method => [method, async input => {
    calls.push({ method, input }); return { marker: method };
  }]));
  const artifacts = { replacePurchaseArtifact: async input => { calls.push({ method: 'replacePurchaseArtifact', input }); return { id: 'fake-artifact' }; } };
  const db = { fixtureOnly: true };
  const app = express(); app.use(express.json());
  app.use('/api/trackb/dual-purchase', createDualStaffPurchaseRouter({ staffService: service, artifactService: artifacts, db }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const token = role => jwt.sign({ role, name: '가짜 직원', id: 'fake-admin' }, process.env.JWT_SECRET);
  const reviewerToken = issueReviewerSession({ ownerReviewerId: 'fake-owner', loginName: '가짜 구매자', loginPhone8: '00000000' });
  const routes = [['POST', '/identity-review', 'resolveBundleIdentityReview'], ['PATCH', '/amount', 'amendBundlePurchaseAmount'], ['POST', '/artifact-replace', 'replacePurchaseArtifact']];
  const request = async (method, route, body, auth) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/trackb/dual-purchase' + route, {
      method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    runtime.__setReadinessForTest({});
    for (const [method, route] of routes) {
      assert.equal((await request(method, route, {}, null)).status, 401);
      assert.equal((await request(method, route, {}, reviewerToken)).status, 401);
      assert.equal((await request(method, route, {}, token('advertiser'))).status, 403);
      const denied = await request(method, route, { orderSubmissionId: orderId, operationalEnabled: true, payment: true, review: true }, token('staff'));
      assert.equal(denied.status, 409);
      assert.equal(denied.body.code, 'dual_channel_not_ready');
    }
    assert.equal(calls.length, 0);
    runtime.__setReadinessForTest({ version: 1, settings: true, roundtrip: true, recruitment: true, purchase: true, review: true, payment: true, operationalEnabled: true });
    for (const [method, route, target] of routes) {
      if (target === 'replacePurchaseArtifact') {
        // 1차 운영: 준비가 모두 켜져도 구매사진 교체·복원은 닫혀 있고 서비스는 불리지 않는다(dualPhase1Manual.test.js).
        const closed = await request(method, route, { orderSubmissionId: orderId }, token('staff'));
        assert.equal(closed.status, 409); assert.equal(closed.body.code, 'dual_phase1_manual');
        continue;
      }
      const result = await request(method, route, { orderSubmissionId: orderId, actor: 'foreign', db: 'foreign', lockedScope: { campaignIds: [] }, paidAmount: 10000, channel: 'coupang', expectedRevision: 1, note: '가짜 확인', decision: 'confirmed' }, token('staff'));
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      const call = calls.at(-1);
      assert.equal(call.method, target);
      assert.equal(call.input.actor, '가짜 직원');
      assert.equal(call.input.orderSubmissionId, orderId);
      assert.equal(Object.hasOwn(call.input, 'lockedScope'), false);
      if (target !== 'replacePurchaseArtifact') assert.equal(call.input.db, db);
      else assert.equal(Object.hasOwn(call.input, 'db'), false);
    }
    assert.equal(calls.length, 2);
  } finally {
    runtime.__setReadinessForTest({});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
