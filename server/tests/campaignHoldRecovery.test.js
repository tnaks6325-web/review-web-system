const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sessionIdentityScope, recoverActiveHolds } = require('../src/services/campaignHoldRecovery.service');

const owner = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '본인', phone8: '12345678',
  sub_accounts: [{ name: '타계정', phone: '010-8765-4321' }],
};
const selfSession = { ownerReviewerId: owner.id, loginName: '본인', loginPhone8: '12345678', loginKind: 'self' };
const subSession = { ownerReviewerId: owner.id, loginName: '타계정', loginPhone8: '87654321', loginKind: 'sub' };

function app(overrides = {}) {
  return {
    id: 7, status: 'applied', expires_at: new Date(Date.now() + 600000).toISOString(),
    applied_at: new Date().toISOString(), option_key: null, hold_token: 'secret-hold',
    phone8: '12345678', owner_phone8: '12345678', applicant_name: '본인',
    ...overrides,
  };
}

function db(apps, queryCheck) {
  let count = 0;
  return {
    async query(sql, params) {
      count++;
      if (count === 1) return { rows: [owner] };
      if (queryCheck) queryCheck(sql, params);
      return { rows: apps };
    },
    get count() { return count; },
  };
}

(async () => {
  const selfScope = sessionIdentityScope(owner, selfSession);
  assert.deepStrictEqual(selfScope.identities.map(row => row.phone8), ['12345678', '87654321']);
  assert.strictEqual(sessionIdentityScope(owner, subSession).identities.length, 1);
  assert.strictEqual(sessionIdentityScope(owner, { ...subSession, loginName: '위조' }), null);

  const samePhoneOwner = { ...owner, sub_accounts: [{ name: '동일번호타계정', phone: '010-1234-5678' }] };
  const samePhoneSubSession = { ...subSession, loginName: '동일번호타계정', loginPhone8: '12345678' };
  assert.strictEqual(sessionIdentityScope(samePhoneOwner, samePhoneSubSession).identities[0].name, '동일번호타계정');

  const ownDb = db([app(), app({ id: 8, phone8: '87654321', applicant_name: '타계정', hold_token: 'sub-secret' })], (sql, params) => {
    assert.match(sql, /owner_reviewer_id = \$2::uuid/);
    assert.match(sql, /owner_reviewer_id IS NULL AND owner_phone8 = \$3/);
    assert.match(sql, /status = 'applied' AND expires_at > NOW\(\)/);
    assert.deepStrictEqual(params[3], ['12345678', '87654321']);
  });
  const own = await recoverActiveHolds(ownDb, { campaignId: 'camp_test', session: selfSession });
  assert.strictEqual(own.authorized, true);
  assert.strictEqual(own.holds.length, 2);
  assert.strictEqual(own.holds[1].isSub, true);

  const subDb = db([app({ id: 8, phone8: '87654321', applicant_name: '타계정', hold_token: 'sub-secret' })], (_sql, params) => {
    assert.deepStrictEqual(params[3], ['87654321']);
  });
  const sub = await recoverActiveHolds(subDb, { campaignId: 'camp_test', session: subSession });
  assert.deepStrictEqual(sub.holds.map(row => row.phone8), ['87654321']);

  const samePhoneDb = {
    queryCount: 0,
    async query(_sql, params) {
      this.queryCount++;
      if (this.queryCount === 1) return { rows: [samePhoneOwner] };
      assert.deepStrictEqual(params[3], ['12345678']);
      return { rows: [app({ applicant_name: '동일번호타계정' })] };
    },
  };
  const samePhoneSub = await recoverActiveHolds(samePhoneDb, {
    campaignId: 'camp_test', session: samePhoneSubSession,
  });
  assert.strictEqual(samePhoneSub.holds[0].name, '동일번호타계정');

  const forgedDb = db([]);
  const forged = await recoverActiveHolds(forgedDb, { campaignId: 'camp_test', session: { ...subSession, loginName: '위조' } });
  assert.strictEqual(forged.authorized, false);
  assert.strictEqual(forgedDb.count, 1, '명의 검증 실패 시 참여 원장을 조회하지 않는다');

  const mismatched = await recoverActiveHolds(db([app({ applicant_name: '다른사람' })]), {
    campaignId: 'camp_test', session: selfSession,
  });
  assert.strictEqual(mismatched.holds.length, 0, '같은 번호라도 명의가 다르면 토큰을 반환하지 않는다');

  const inactive = await recoverActiveHolds(db([
    app({ id: 10, status: 'applied', expires_at: new Date(Date.now() - 1000).toISOString() }),
    app({ id: 11, status: 'submitted', expires_at: new Date(Date.now() + 600000).toISOString() }),
  ]), { campaignId: 'camp_test', session: selfSession });
  assert.strictEqual(inactive.holds.length, 0, '만료되거나 제출된 행의 토큰은 반환하지 않는다');

  const pending = await recoverActiveHolds(db([app({ id: 12, status: 'blog_pending', expires_at: null })]), {
    campaignId: 'camp_test', session: selfSession,
  });
  assert.strictEqual(pending.holds.length, 1, '승인 대기형 참여는 만료시각 없이도 복원한다');

  const duplicate = await recoverActiveHolds(db([app(), app({ id: 9, hold_token: 'older' })]), {
    campaignId: 'camp_test', session: selfSession,
  });
  assert.strictEqual(duplicate.holds.length, 1, '같은 명의의 활성 행은 한 건만 복원한다');

  const campaign = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'campaign.html'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
  assert.match(routes, /router\.get\('\/:id\/my-active-holds', reviewerSessionMiddleware, detailLimiter/);
  assert.match(routes, /Cache-Control', 'no-store'/);
  assert.match(campaign, /await recoverActiveHolds\(\);\s*\n\s*const h = getHold\(\)/);
  assert.match(campaign, /j\.reason === 'duplicate_hold' && await recoverActiveHolds\(\(sub && sub\.phone\) \|\| s\.phone8\)/);
  assert.match(campaign, /headers:\{'Content-Type':'application\/json', \.\.\._getAuthHeaders\(\)\}/);
  assert.match(campaign, /recovered\.includes\(preferredP8\) \? preferredP8/);
  console.log('✓ campaign hold recovery: owner, sub-account, auth, expiry SQL, duplicate fallback, client restore');
})().catch(err => { console.error(err); process.exitCode = 1; });
