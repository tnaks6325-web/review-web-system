'use strict';
// 동시진행 리뷰 사진 업로드·완료 HTTP 입구 — 실제 Express 라우터 + 실제 리뷰어 JWT(시험 안 임의 비밀).
process.env.JWT_SECRET = require('node:crypto').randomBytes(48).toString('hex');
require('./helpers/dualChannelDependencies.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');
const { imageUploadLimiter } = require('../src/middleware/rateLimit.middleware');
const { createDualPurchaseImageRouter } = require('../src/routes/dualChannelHttp.routes');

const STAGE_KEYS = ['orderSubmissionId', 'sheetId', 'tabName', 'rowIndex', 'slotKey', 'imageBase64', 'mimeType', 'expectedRevision', 'replaceFileId'];
const COMPLETE_KEYS = ['orderSubmissionId', 'sheetId', 'tabName', 'rowIndex', 'uploadTokens'];
const FORGED = {
  actor: 'forged-staff', lockedScope: { forged: true }, scope: { forged: true }, client: { forged: true },
  snapshot: { forged: true }, conditionSnapshot: { forged: true }, reviewerSession: { ownerReviewerId: 'foreign' },
  folderId: 'untrusted-folder', ownerReviewerId: 'foreign', reviewerName: 'forged-name', slotRole: 'receipt', expectedChannel: 'coupang',
};
const reviewerToken = (ownerReviewerId = 'fake-owner') => issueReviewerSession({ ownerReviewerId, loginName: '가짜 리뷰어', loginPhone8: '00000000' });

let serverCount = 0;
async function withServer(options, run) {
  const clientIp = '10.0.0.' + (++serverCount); // separate rate-limit bucket per server
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/image/dual', createDualPurchaseImageRouter(options));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/image/dual';
  try {
    await run(async (route, body, token, extraHeaders = {}) => {
      const response = await fetch(base + route, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': clientIp, ...(token ? { 'x-reviewer-token': token } : {}), ...extraHeaders },
        body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
function recordingService(results = {}) {
  const calls = [];
  const service = {
    stageReviewUpload: async args => { calls.push({ method: 'stageReviewUpload', args }); return results.stage ? results.stage(args) : {
      fileId: 'file-1', uploadToken: 'token-1', slotRole: 'review', expectedChannel: 'naver',
      evidence: { slot_key: 'review', evidence_revision: 1, reviewer_name: 'private-name', sheet_id: 'private-sheet', file_hash: 'f'.repeat(64) },
      conditionSnapshot: { private: 'private-snapshot' },
    }; },
    completeReviewUpload: async args => { calls.push({ method: 'completeReviewUpload', args }); return results.complete ? results.complete(args) : {
      complete: true, reasons: [],
      current: [{ slot_key: 'review', file_id: 'file-1', reviewer_name: 'private-name' }, { slot_key: 'slot2', file_id: 'file-2' }],
      bundle: { parent: { owner_reviewer_id: 'private-owner', participant_identity_key_hash: 'private-identity' }, channels: [{ phone: '01099998888', address: 'private-address' }] },
      slots: [{ key: 'review' }, { key: 'slot2' }],
    }; },
  };
  return { calls, service };
}

test('review upload HTTP rejects missing, staff and forged reviewer sessions before any service call', async () => {
  const { calls, service } = recordingService();
  const staffToken = jwt.sign({ role: 'admin', ownerReviewerId: 'fake-owner' }, process.env.JWT_SECRET);
  const otherSecret = jwt.sign({ scope: 'reviewer_session', ownerReviewerId: 'fake-owner' }, 'not-the-server-secret', { issuer: 'review-web-system', audience: 'reviewer-app' });
  await withServer({ reviewService: service }, async post => {
    for (const route of ['/review-stage', '/review-complete']) {
      for (const token of [undefined, staffToken, otherSecret]) {
        const result = await post(route, { orderSubmissionId: 'o', reviewerSession: { ownerReviewerId: 'fake-owner' } }, token);
        assert.equal(result.status, 401, route);
        assert.equal(result.body.ok, false);
      }
    }
  });
  assert.equal(calls.length, 0);
});

test('readiness stays closed by default: body, header and environment flags cannot open review upload (409, no DB)', async () => {
  const pool = require('../src/db/pool');
  let dbTouches = 0;
  const originalQuery = pool.query, originalConnect = pool.connect;
  pool.query = async () => { dbTouches++; throw new Error('db touched'); };
  pool.connect = async () => { dbTouches++; throw new Error('db touched'); };
  const savedEnv = { ...process.env };
  Object.assign(process.env, { DUAL_CHANNEL_READY: 'true', DUAL_CHANNEL_REVIEW_READY: 'true', DUAL_CHANNEL_OPERATIONAL_ENABLED: 'true' });
  try {
    assert.equal(require('../src/services/dualChannelRuntime.service').isDualChannelReady('review'), false);
    await withServer({}, async post => {
      const open = { ready: true, review: true, operationalEnabled: true, readiness: { settings: true, roundtrip: true, purchase: true, review: true, operationalEnabled: true } };
      const headers = { 'x-dual-channel-ready': 'true', 'x-dual-channel-readiness': 'review' };
      for (const [route, body] of [
        ['/review-stage', { orderSubmissionId: 'o', sheetId: 's', tabName: 't', rowIndex: 2, slotKey: 'review', imageBase64: 'AA==', expectedRevision: 0, ...open }],
        ['/review-complete', { orderSubmissionId: 'o', sheetId: 's', tabName: 't', rowIndex: 2, uploadTokens: ['x'], ...open }],
      ]) {
        const result = await post(route, body, reviewerToken(), headers);
        assert.equal(result.status, 409, route);
        assert.equal(result.body.ok, false);
        assert.equal(result.body.code, 'dual_channel_not_ready');
      }
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    pool.query = originalQuery; pool.connect = originalConnect;
  }
  assert.equal(dbTouches, 0);
});

test('review upload HTTP copies only allow-listed body keys and forwards the verified reviewer session separately', async () => {
  const { calls, service } = recordingService();
  const token = reviewerToken();
  const stageBody = { orderSubmissionId: 'o-1', sheetId: 's', tabName: 't', rowIndex: 2, slotKey: 'slot2', imageBase64: 'AAAA', mimeType: 'image/png', expectedRevision: 3, replaceFileId: 'old-file' };
  const completeBody = { orderSubmissionId: 'o-1', sheetId: 's', tabName: 't', rowIndex: 2, uploadTokens: ['a', 'b'] };
  await withServer({ reviewService: service }, async post => {
    const raw = JSON.stringify({ ...stageBody, ...FORGED }).replace(/^\{/, '{"__proto__":{"actor":"proto-staff"},"constructor":{"prototype":{"actor":"c"}},');
    assert.equal((await post('/review-stage', raw, token)).status, 200);
    assert.equal((await post('/review-complete', { ...completeBody, ...FORGED }, token)).status, 200);
  });
  assert.deepEqual(calls.map(c => c.method), ['stageReviewUpload', 'completeReviewUpload']);
  for (const [call, keys, expected] of [[calls[0], STAGE_KEYS, stageBody], [calls[1], COMPLETE_KEYS, completeBody]]) {
    assert.deepEqual(Object.keys(call.args).sort(), ['body', 'reviewerSession']);
    assert.deepEqual(call.args.body, expected);
    assert.equal(Object.getPrototypeOf(call.args.body), Object.prototype);
    assert.equal(call.args.body.actor, undefined);
    assert.ok(Object.keys(call.args.body).every(k => keys.includes(k)));
    assert.equal(call.args.reviewerSession.ownerReviewerId, 'fake-owner');
    assert.equal(call.args.reviewerSession.scope, 'reviewer_session');
  }
});

test('review upload HTTP returns only a safe projection on success', async () => {
  const { service } = recordingService();
  await withServer({ reviewService: service }, async post => {
    const staged = await post('/review-stage', { orderSubmissionId: 'o' }, reviewerToken());
    assert.equal(staged.status, 200);
    assert.deepEqual(staged.body, { ok: true, fileId: 'file-1', uploadToken: 'token-1', slotKey: 'review', channel: 'naver', role: 'review', revision: 1 });
    const done = await post('/review-complete', { orderSubmissionId: 'o', uploadTokens: ['token-1'] }, reviewerToken());
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ok: true, complete: true, reasons: [], submittedSlots: ['review', 'slot2'] });
    assert.doesNotMatch(JSON.stringify([staged.body, done.body]), /private/);
  });
});

for (const field of ['status', 'statusCode']) {
  for (const status of [500, 503]) {
    test(`review upload HTTP masks returned ${field} ${status} and keeps the server status`, async () => {
      const failing = async () => ({ ok: false, [field]: status, code: 'PRIVATE_FAKE_CODE', error: 'private-fake-detail' });
      await withServer({ reviewService: { stageReviewUpload: failing, completeReviewUpload: failing } }, async post => {
        for (const route of ['/review-stage', '/review-complete']) {
          const result = await post(route, { orderSubmissionId: 'o', uploadTokens: ['t'] }, reviewerToken());
          assert.equal(result.status, status);
          assert.deepEqual(result.body, { ok: false, code: 'dual_review_failed', error: '리뷰 사진을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' });
        }
      });
    });
  }
}

test('review upload HTTP reports expected conflicts, hides thrown internals and rejects malformed bodies without a service call', async () => {
  let mode = 'conflict', calls = 0;
  const run = async () => {
    calls++;
    if (mode === 'conflict') throw Object.assign(new Error('사진이 바뀌었습니다. 새로고침해주세요.'), { status: 409, code: 'review_revision_changed' });
    if (mode === 'returned') return { ok: false, code: 'duplicate_evidence', error: '이미 제출된 사진입니다.' };
    if (mode === 'invalid') return null;
    throw new Error('private-fake-db-detail');
  };
  await withServer({ reviewService: { stageReviewUpload: run, completeReviewUpload: run } }, async post => {
    const token = reviewerToken();
    let r = await post('/review-stage', {}, token);
    assert.equal(r.status, 409); assert.equal(r.body.code, 'review_revision_changed');
    mode = 'returned'; r = await post('/review-complete', { uploadTokens: ['t'] }, token);
    assert.equal(r.status, 409); assert.equal(r.body.code, 'duplicate_evidence');
    for (mode of ['invalid', 'thrown']) {
      r = await post('/review-stage', {}, token);
      assert.equal(r.status, 500); assert.equal(r.body.code, 'dual_review_failed');
      assert.doesNotMatch(JSON.stringify(r.body), /private/);
    }
    const before = calls;
    assert.equal((await post('/review-stage', [], token)).status, 400);
    assert.equal((await post('/review-complete', [], token)).status, 400);
    for (const uploadTokens of ['one', [1], Array.from({ length: 21 }, (_, i) => 't' + i)]) {
      assert.equal((await post('/review-complete', { uploadTokens }, token)).status, 400);
    }
    assert.equal(calls, before);
  });
});

test('review upload routes are throttled by the shared upload limiter (31st request in a minute is 429)', async () => {
  const { calls, service } = recordingService();
  await withServer({ reviewService: service }, async post => {
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await post(i % 2 ? '/review-complete' : '/review-stage', { uploadTokens: ['t'] }, reviewerToken())).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
    assert.equal(statuses[30], 429);
  });
  assert.equal(calls.length, 30);
});

test('review upload routes use the upload rate limiter after reviewer authentication', () => {
  const router = createDualPurchaseImageRouter();
  for (const path of ['/review-stage', '/review-complete']) {
    const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods.post);
    assert.ok(layer, path + ' missing');
    const handles = layer.route.stack.map(s => s.handle);
    assert.equal(handles[0].name, 'reviewerSessionMiddleware');
    assert.equal(handles[1], imageUploadLimiter);
  }
});

test('actual HTTP + real review service + real 215 SQL: two-review completion and multi-photo slot revision policy', async () => {
  const { fixture, id, owner } = require('./helpers/dualChannelRealFixture');
  const lifecycle = require('../src/services/dualChannelLifecycle.service');
  const review = require('../src/services/dualChannelReview.service');
  const db = await fixture(); // explicit test DI opens readiness only inside this process
  const files = new Map(); let n = 0;
  const drive = { upload: async bytes => { const f = 'uploaded-' + (++n); files.set(f, bytes); return f; }, read: async f => files.get(f) };
  const service = review.createService({ db, lifecycle, drive, authorizeTarget: async () => true });
  const base = { orderSubmissionId: id, sheetId: 's', tabName: 't', rowIndex: 2 };
  const photo = s => Buffer.from(s).toString('base64');
  try {
    await withServer({ reviewService: service }, async post => {
      const token = reviewerToken(owner);
      const foreign = await post('/review-stage', { ...base, slotKey: 'review', imageBase64: photo('x'), expectedRevision: 0 }, reviewerToken('00000000-0000-4000-8000-0000000000ff'));
      assert.equal(foreign.status, 409); assert.equal(foreign.body.code, 'review_owner_changed');
      // Forged actor/snapshot from the body must not change the slot role the server derives.
      const a = await post('/review-stage', { ...base, ...FORGED, slotKey: 'review', imageBase64: photo('naver-a'), expectedRevision: 0 }, token);
      assert.equal(a.status, 200); assert.equal(a.body.channel, 'naver'); assert.equal(a.body.role, 'review'); assert.equal(a.body.revision, 1);
      const stale = await post('/review-stage', { ...base, slotKey: 'review', imageBase64: photo('naver-stale'), expectedRevision: 0 }, token);
      assert.equal(stale.status, 409); assert.equal(stale.body.code, 'review_revision_changed');
      const b = await post('/review-stage', { ...base, slotKey: 'review', imageBase64: photo('naver-b'), expectedRevision: a.body.revision }, token);
      assert.equal(b.status, 200); assert.equal(b.body.revision, 2);
      const c = await post('/review-stage', { ...base, slotKey: 'slot2', imageBase64: photo('coupang-c'), expectedRevision: 0 }, token);
      assert.equal(c.status, 200); assert.equal(c.body.channel, 'coupang'); assert.equal(c.body.role, 'review');
      const rows = (await db.query('SELECT file_id,evidence_revision,reviewer_name FROM review_submissions ORDER BY file_id')).rows;
      assert.deepEqual(rows.map(r => [r.file_id, r.evidence_revision]), [['uploaded-1', 2], ['uploaded-2', 2], ['uploaded-3', 1]]);
      assert.ok(rows.every(r => r.reviewer_name !== 'forged-name'));
      // Blocker 6: the first photo's token was signed at revision 1 while its row is now revision 2.
      // It is still the same, non-superseded file/bytes/channel/role/snapshot/owner, so it must count.
      const done = await post('/review-complete', { ...base, uploadTokens: [a.body.uploadToken, b.body.uploadToken, c.body.uploadToken] }, token);
      assert.equal(done.status, 200);
      assert.deepEqual(done.body, { ok: true, complete: true, reasons: [], submittedSlots: ['review', 'slot2'] });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM review_submissions WHERE completed_at IS NOT NULL')).rows[0].n, 3);
      const state = await review.evaluateBundleReviewCompletion(db, { orderSubmissionId: id });
      assert.deepEqual(state.current.map(r => r.file_id).sort(), ['uploaded-1', 'uploaded-2', 'uploaded-3']);
      // Replacing a photo supersedes it: its old token can never complete again.
      const d = await post('/review-stage', { ...base, slotKey: 'review', imageBase64: photo('naver-d'), expectedRevision: 2, replaceFileId: 'uploaded-1' }, token);
      assert.equal(d.status, 200); assert.equal(d.body.revision, 3);
      const replayed = await post('/review-complete', { ...base, uploadTokens: [a.body.uploadToken] }, token);
      assert.equal(replayed.status, 409); assert.equal(replayed.body.code, 'review_upload_proof_invalid');
      const otherOwner = await post('/review-complete', { ...base, uploadTokens: [d.body.uploadToken] }, reviewerToken('00000000-0000-4000-8000-0000000000ff'));
      assert.equal(otherOwner.status, 409);
      const after = await post('/review-complete', { ...base, uploadTokens: [d.body.uploadToken] }, token);
      assert.equal(after.status, 200); assert.equal(after.body.complete, true);
      assert.deepEqual((await review.evaluateBundleReviewCompletion(db, { orderSubmissionId: id })).current.map(r => r.file_id).sort(), ['uploaded-2', 'uploaded-3', 'uploaded-4']);
    });
  } finally { await db.close(); }
});
