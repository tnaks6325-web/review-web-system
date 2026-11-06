'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');
const { createDualPurchaseImageRouter } = require('../src/routes/dualChannelHttp.routes');

async function withServer(service, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/image/dual', createDualPurchaseImageRouter({ purchaseService: service }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/image/dual';
  try { await run(async (route, body, token) => {
    const response = await fetch(base + route, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-reviewer-token': token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('actual HTTP verifies reviewer sessions before every dual image operation and forwards only verified actor context', async () => {
  const calls = [];
  const service = Object.fromEntries(['extractPurchase', 'stagePurchaseArtifact', 'issueBundleApproval'].map(method => [method, async args => {
    calls.push({ method, args });
    return method === 'stagePurchaseArtifact' ? { id: 'fake-artifact', channel: 'naver' } : { marker: method };
  }]));
  const token = issueReviewerSession({ ownerReviewerId: 'fake-owner', loginName: '가짜 구매자', loginPhone8: '00000000' });
  const staffToken = jwt.sign({ role: 'admin', ownerReviewerId: 'fake-owner' }, process.env.JWT_SECRET);
  await withServer(service, async post => {
    for (const route of ['/extract', '/artifacts', '/approve']) {
      assert.equal((await post(route, {}, undefined)).status, 401);
      assert.equal((await post(route, {}, staffToken)).status, 401);
    }
    assert.equal(calls.length, 0);
    for (const [route, method] of [['/extract', 'extractPurchase'], ['/artifacts', 'stagePurchaseArtifact'], ['/approve', 'issueBundleApproval']]) {
      const result = await post(route, { campaignApplicationId: 11, folderId: 'untrusted-folder', reviewerSession: { ownerReviewerId: 'foreign' } }, token);
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      const call = calls.at(-1);
      assert.equal(call.method, method);
      assert.equal(call.args.reviewerSession.ownerReviewerId, 'fake-owner');
      assert.equal(call.args.body.campaignApplicationId, 11);
      assert.equal(Object.hasOwn(call.args.body, 'folderId'), false);
      assert.equal(Object.hasOwn(call.args.body, 'reviewerSession'), false);
      if (route === '/artifacts') assert.equal(result.body.artifact.id, 'fake-artifact');
    }
    assert.equal(calls.length, 3);
  });
});

test('actual HTTP translates the server readiness error without requiring transport fields on the runtime service', async () => {
  const token = issueReviewerSession({ ownerReviewerId: 'fake-owner', loginName: '가짜 구매자', loginPhone8: '00000000' });
  const service = { issueBundleApproval: async () => {
    const error = new Error('아직 준비 중입니다.');
    error.code = 'dual_channel_not_ready';
    throw error;
  } };
  await withServer(service, async post => {
    const result = await post('/approve', {}, token);
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.code, 'dual_channel_not_ready');
  });
});

for (const field of ['status', 'statusCode']) {
  for (const status of [500, 503]) {
    test(`actual HTTP masks returned ${field} ${status} without changing server error status`, async () => {
      const token = issueReviewerSession({ ownerReviewerId: 'fake-owner', loginName: '가짜 구매자', loginPhone8: '00000000' });
      const service = { issueBundleApproval: async () => ({
        ok: false, [field]: status, code: 'PRIVATE_FAKE_CODE', error: 'private-fake-detail',
      }) };
      await withServer(service, async post => {
        const result = await post('/approve', {}, token);
        assert.equal(JSON.stringify(result.body).includes('private-fake-detail'), false);
        assert.equal(result.status, status);
        assert.deepEqual(result.body, {
          ok: false, code: 'dual_purchase_failed',
          error: '구매사진을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.',
        });
      });
    });
  }
}

test('dual image HTTP preserves explicit rejection, reports expected conflicts and hides unexpected backend details', async () => {
  let mode = 'reject';
  let calls = 0;
  const token = issueReviewerSession({ ownerReviewerId: 'fake-owner', loginName: '가짜 구매자', loginPhone8: '00000000' });
  const service = { extractPurchase: async () => {
    calls++;
    if (mode === 'reject') return { ok: false, code: 'DUAL_REJECTED', error: '사진을 다시 확인해주세요.' };
    if (mode === 'conflict') {
      const error = new Error('사진이 바뀌었습니다. 다시 확인해주세요.');
      error.status = 409;
      error.code = 'DUAL_ARTIFACT_CHANGED';
      throw error;
    }
    throw new Error('private-fake-db-detail');
  } };
  await withServer(service, async post => {
    const rejected = await post('/extract', {}, token);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.ok, false);
    assert.equal(rejected.body.code, 'DUAL_REJECTED');
    mode = 'conflict';
    const conflict = await post('/extract', {}, token);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.ok, false);
    assert.equal(conflict.body.code, 'DUAL_ARTIFACT_CHANGED');
    mode = 'unexpected';
    const unexpected = await post('/extract', {}, token);
    assert.equal(unexpected.status, 500);
    assert.equal(unexpected.body.ok, false);
    assert.equal(JSON.stringify(unexpected.body).includes('private-fake-db-detail'), false);
    const before = calls;
    assert.equal((await post('/extract', [], token)).status, 400);
    assert.equal(calls, before);
  });
});
