const assert = require('assert');

const servicePath = require.resolve('../src/services/trackB.service');
let allowed = false;
let seen = null;
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    canAccessTab: async (args) => {
      seen = args;
      return allowed;
    },
  },
};

const { tabConfigWriteScopeMiddleware } = require('../src/middleware/tabConfigScope.middleware');

async function run({ role, name = '', body = {} }) {
  let status = 200;
  let json = null;
  let nextCalled = false;
  let nextError = null;
  const req = { admin: role ? { role, name } : null, body };
  const res = {
    status(code) { status = code; return this; },
    json(value) { json = value; return this; },
  };
  await tabConfigWriteScopeMiddleware(req, res, (err) => {
    nextCalled = true;
    nextError = err || null;
  });
  return { status, json, nextCalled, nextError };
}

(async () => {
  assert.strictEqual((await run({ role: 'advertiser' })).status, 403);
  assert.strictEqual((await run({ role: 'admin' })).nextCalled, true);
  assert.strictEqual((await run({ role: 'master' })).nextCalled, true);

  allowed = false;
  let result = await run({
    role: 'staff', name: '망고', body: { sheetId: 'sheet-1', tabName: '8/11' },
  });
  assert.strictEqual(result.status, 403);
  assert.deepStrictEqual(seen, {
    role: 'staff', staffName: '망고', sheetId: 'sheet-1', tabName: '8/11',
  });

  allowed = true;
  result = await run({
    role: 'staff', name: '망고', body: { sheetId: 'sheet-1', tabName: '8/11' },
  });
  assert.strictEqual(result.nextCalled, true);
  assert.strictEqual(result.nextError, null);

  console.log('✅ tabConfigScope: 외부 차단, 관리자 전체, AE 담당 탭 범위 통과');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
