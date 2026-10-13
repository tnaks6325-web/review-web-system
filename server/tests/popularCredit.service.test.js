const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  POPULAR_CREDIT_VALIDITY_DAYS,
  calculatePopularCreditMatches,
  calculatePopularCreditState,
  loadPopularCreditState,
  canUsePopularCredit,
} = require('../src/services/popularCredit.service');

const NOW = new Date('2026-09-11T08:00:00.000Z');
const ago = (hours) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
const normal = (id, hoursAgo) => ({ id, event_type: 'normal', event_at: ago(hoursAgo) });
const popular = (id, hoursAgo) => ({ id, event_type: 'popular', event_at: ago(hoursAgo) });
const state = (events) => calculatePopularCreditState(events, NOW);

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'popularCredit.service.js'), 'utf8');
  assert.match(source, /COALESCE\(ca\.is_popular_snapshot, rc\.is_popular\)/, 'credit type is immutable after the application snapshot is recorded');
  assert.equal(POPULAR_CREDIT_VALIDITY_DAYS, 1, 'normal participation credit lasts one day');
  assert.equal(canUsePopularCredit(state([])), false, 'general completion 0 blocks popular participation');
  assert.deepEqual(state([normal(1, 23)]), { normalDone: 1, popularUsed: 0, credits: 1, validityDays: 1 },
    'a normal submission within 24 hours grants one credit');
  assert.equal(state([normal(1, 24)]).credits, 1, 'the exact 24-hour boundary is included');
  assert.equal(state([normal(1, 24.01)]).credits, 0, 'a normal submission older than 24 hours expires immediately');
  assert.deepEqual(state([normal(1, 20), popular(2, 10)]),
    { normalDone: 1, popularUsed: 1, credits: 0, validityDays: 1 },
    'a later popular participation consumes the valid credit');
  assert.equal(state([popular(1, 20), normal(2, 10)]).credits, 1,
    'an older popular participation cannot consume a newly earned credit');
  assert.deepEqual(state([normal(1, 30), normal(2, 20), popular(3, 10)]),
    { normalDone: 1, popularUsed: 1, credits: 0, validityDays: 1 },
    'retroactive matching excludes the expired old credit before consuming a recent credit');
  const matched = calculatePopularCreditMatches([normal(10, 18), popular(11, 15), normal(12, 12)], NOW);
  assert.deepEqual([...matched.matchedNormalIds], ['10'], 'FIFO matching exposes the exact normal application used by observability');
  assert.deepEqual([...matched.matchedPopularIds], ['11'], 'FIFO matching exposes the exact popular application that consumed credit');
  const augustHistory = [
    ...Array.from({ length: 21 }, (_, i) => ({ id: i + 1, event_type: 'normal', event_at: '2026-08-01T08:00:00.000Z' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: i + 22, event_type: 'popular', event_at: '2026-08-02T08:00:00.000Z' })),
  ];
  assert.deepEqual(state(augustHistory), { normalDone: 0, popularUsed: 0, credits: 0, validityDays: 1 },
    'the old 21 minus 5 history does not preserve 16 credits after the retroactive cutoff');

  let params;
  let directParams = null;
  const isDirectSql = (sql) => /FROM order_submissions os/.test(sql);
  const db = { query: async (sql, values) => {
    if (isDirectSql(sql)) { directParams = values; return { rows: [] }; }
    params = values; return { rows: [{ ...normal(10, 1), phone8: '12345678' }] };
  } };
  const loaded = await loadPopularCreditState(db, '12345678', { evaluatedAt: NOW });
  assert.equal(loaded.credits, 1, 'database events use the same calculation');
  // 결정 238 — 바로 구매(공고 참여 없이 낸 주문)도 리뷰어 판정에서 일반/인기 참여로 센다.
  assert.ok(directParams, 'reviewer credit state also reads direct purchases');
  assert.equal(new Date(directParams[0]).toISOString(), ago(24), 'direct purchases use the same 24-hour cutoff');
  assert.deepEqual(directParams[2], ['12345678'], 'direct purchases are scoped to the same identity');
  const withDirect = (directRows) => ({ query: async (sql) => (isDirectSql(sql)
    ? { rows: directRows.map((r) => ({ ...r, phone8: '12345678' })) } : { rows: [] }) });
  assert.equal((await loadPopularCreditState(withDirect([{ ...normal('os:7', 2), status: 'submitted' }]), '12345678', { evaluatedAt: NOW })).credits, 1,
    'a direct purchase on a normal campaign worktable earns one credit');
  assert.equal((await loadPopularCreditState(withDirect([normal('os:7', 3), popular('os:8', 1)]), '12345678', { evaluatedAt: NOW })).credits, 0,
    'a direct purchase on a popular campaign worktable consumes the credit');
  directParams = null;
  await loadPopularCreditState(db, '12345678', { evaluatedAt: NOW, includeDirectPurchases: false });
  assert.equal(directParams, null, 'includeDirectPurchases:false keeps the legacy calculation (fallback path)');
  assert.deepEqual(calculatePopularCreditState([normal('os:2', 5), normal(1, 5), popular(3, 1)], NOW),
    { normalDone: 2, popularUsed: 1, credits: 1, validityDays: 1 }, 'mixed numeric and prefixed ids sort without NaN');
  assert.equal(new Date(params[0]).toISOString(), ago(24), 'database query starts at the rolling 24-hour cutoff');
  assert.equal(new Date(params[1]).toISOString(), NOW.toISOString(), 'database query does not include future events');
  assert.deepEqual(params[2], ['12345678'], 'credit accounting is isolated by participating identity');
  assert.match(source, /ca\.expires_at > \$2/, 'only currently active popular holds consume credit');
  assert.match(source, /ca\.status = 'blog_pending'/, 'a pending popular application reserves its credit until rejection or cancellation');
  console.log('popularCredit.service: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
