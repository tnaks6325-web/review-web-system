'use strict';

// 실제 Express 라우트 핸들러를 DB 스텁과 함께 호출해
// 본계정 + 타계정 3개의 명의별 재참여 상태 응답을 검증한다.
const assert = require('assert');
const pool = require('../src/db/pool');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const now = Date.now();
const accountRows = [
  { campaign_id: 'camp-a', repurchase_days: 14, phone8: '12345678', last_submitted_at: new Date(now - 4 * 86400000), ownership_verified: true },
  { campaign_id: 'camp-a', repurchase_days: 14, phone8: '22223333', last_submitted_at: null, ownership_verified: false },
  { campaign_id: 'camp-a', repurchase_days: 14, phone8: '44445555', last_submitted_at: new Date(now - 20 * 86400000), ownership_verified: false },
  { campaign_id: 'camp-a', repurchase_days: 14, phone8: '66667777', last_submitted_at: new Date(now - 2 * 86400000), ownership_verified: false },
];

let statusSql = '';
let statusParams = null;
pool.query = async (sql, params) => {
  const text = String(sql);
  if (text.includes('SELECT name, phone8, sub_accounts FROM reviewers')) {
    return { rows: [{
      name: '본계정', phone8: '12345678',
      sub_accounts: [
        { name: '타계정1', phone: '010-2222-3333' },
        { name: '타계정2', phone: '010-4444-5555' },
        { name: '타계정3', phone: '010-6666-7777' },
      ],
    }] };
  }
  if (text.includes('SELECT id, multi_account_mode, repurchase_days FROM recruit_campaigns')) {
    return { rows: [{ id: 'camp-a', multi_account_mode: true, repurchase_days: 14 }] };
  }
  if (text.includes('WITH requested_phones AS')) {
    statusSql = text;
    statusParams = params;
    const requested = new Set(params[1]);
    return { rows: accountRows.filter(row => requested.has(row.phone8)) };
  }
  throw new Error('unexpected query: ' + text.slice(0, 100));
};
pool.connect = async () => ({ query: pool.query, release() {} });

const campaignRouter = require('../src/routes/campaign.routes');
function handlerFor(method, routePath) {
  const layer = campaignRouter.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `route not found: ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function callStatus(reviewer) {
  const handler = handlerFor('get', '/my-repurchase-status');
  return await new Promise((resolve, reject) => {
    const req = { query: { ids: 'camp-a' }, reviewer };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

(async () => {
  const selfResult = await callStatus({
    ownerReviewerId: OWNER_ID, loginPhone8: '12345678', loginName: '본계정', loginKind: 'self',
  });
  assert.equal(selfResult.statusCode, 200);
  assert.equal(selfResult.body.ok, true);
  const accounts = selfResult.body.status['camp-a'].accounts;
  assert.equal(accounts.length, 4, '본계정과 등록 타계정 3개를 모두 반환');
  assert.equal(accounts.find(a => a.phone8 === '12345678').status, 'locked', '기간 안의 본계정은 제한 중');
  assert.deepEqual(
    { status: accounts.find(a => a.phone8 === '22223333').status, history: accounts.find(a => a.phone8 === '22223333').history },
    { status: 'ready', history: 'none' },
    '해당 공고 구매 이력이 없는 타계정1은 즉시 참여 가능'
  );
  assert.equal(accounts.find(a => a.phone8 === '44445555').status, 'ready', '14일이 지난 타계정2는 재참여 가능');
  assert.equal(accounts.find(a => a.phone8 === '66667777').status, 'locked', '14일 안의 타계정3은 제한 중');
  assert(accounts.every(a => !Object.prototype.hasOwnProperty.call(a, 'lastSubmittedAt')), '최근 구매시각은 공개 응답에서 제외');
  assert.deepEqual(selfResult.body.status['camp-a'].readyAccounts.sort(), ['22223333', '44445555']);
  assert.equal(statusParams[4], true, 'SMS 없이 등록 타계정 조회 옵션을 명시적으로 사용');
  assert(statusSql.includes('externally_claimed') && statusSql.includes('other.id <> $4::uuid'),
    '다른 리뷰어 본계정·활성 신원과 겹치는 번호는 신뢰 대상에서 제외');
  assert(!statusSql.includes('jsonb_array_elements'), '다른 소유자의 편집 가능한 타계정 목록은 충돌 권위로 쓰지 않음');

  const subResult = await callStatus({
    ownerReviewerId: OWNER_ID, loginPhone8: '22223333', loginName: '타계정1', loginKind: 'sub',
  });
  const subAccounts = subResult.body.status['camp-a'].accounts;
  assert.equal(subAccounts.find(a => a.phone8 === '22223333').status, 'ready', '타계정 로그인 본인은 상태 확인 가능');
  assert(subAccounts.filter(a => a.phone8 !== '22223333').every(a => a.status === 'login_only'),
    '타계정 로그인은 형제 명의를 선택할 수 없음');
  assert.deepEqual(subResult.body.status['camp-a'].readyAccounts, ['22223333']);

  console.log('PASS reviewer repurchase status route: self + 3 sub accounts, no SMS');
})().catch(err => { console.error(err.stack || err); process.exit(1); });
