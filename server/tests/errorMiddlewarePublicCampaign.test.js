'use strict';
/* 공개 리뷰어 참여 경로는 DB/인코딩 원문을 노출하지 않고, 관리자 캠페인 편집은
 * 조치 가능한 원문을 유지한다. 실행: node tests/errorMiddlewarePublicCampaign.test.js */
const assert = require('assert');

process.env.NODE_ENV = 'production';
process.env.ERRORLOG_ENABLED = 'false';
const { errorHandler } = require('../src/middleware/error.middleware');

function invoke(path, admin, extra = {}) {
  let statusCode = null;
  let body = null;
  const req = { path, method: 'POST', query: {}, ip: '127.0.0.1', headers: {}, admin, ...extra };
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  errorHandler(new Error('invalid byte sequence for encoding "UTF8": 0x00'), req, res, () => {});
  return { statusCode, body };
}

const publicApply = invoke('/api/campaign/campaign-1/apply');
assert.strictEqual(publicApply.statusCode, 200);
assert.deepStrictEqual(publicApply.body, { error: '참여 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });

const adminSave = invoke('/api/campaign/admin/campaign-1', { name: 'admin' });
assert.strictEqual(adminSave.statusCode, 200);
assert.strictEqual(adminSave.body.error, 'invalid byte sequence for encoding "UTF8": 0x00');

const adminDetail = invoke('/api/campaign/campaign-1', undefined, { _trustedCampaignAdminError: true });
assert.strictEqual(adminDetail.statusCode, 200);
assert.strictEqual(adminDetail.body.error, 'invalid byte sequence for encoding "UTF8": 0x00');

console.log('✅ errorMiddlewarePublicCampaign: 3 cases passed');
