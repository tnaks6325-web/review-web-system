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
  assert.equal(POPULAR_CREDIT_VALIDITY_DAYS, 3, 'normal participation credit lasts three days');
  assert.equal(canUsePopularCredit(state([])), false, 'general completion 0 blocks popular participation');
  assert.deepEqual(state([normal(1, 71)]), { normalDone: 1, popularUsed: 0, credits: 1, validityDays: 3 },
    'a normal submission within 72 hours grants one credit');
  assert.equal(state([normal(1, 72)]).credits, 1, 'the exact 72-hour boundary is included');
  assert.equal(state([normal(1, 72.01)]).credits, 0, 'a normal submission older than 72 hours expires immediately');
  assert.deepEqual(state([normal(1, 48), popular(2, 24)]),
    { normalDone: 1, popularUsed: 1, credits: 0, validityDays: 3 },
    'a later popular participation consumes the valid credit');
  assert.equal(state([popular(1, 48), normal(2, 24)]).credits, 1,
    'an older popular participation cannot consume a newly earned credit');
  assert.deepEqual(state([normal(1, 80), normal(2, 60), popular(3, 50)]),
    { normalDone: 1, popularUsed: 1, credits: 0, validityDays: 3 },
    'retroactive matching excludes the expired old credit before consuming a recent credit');
  const matched = calculatePopularCreditMatches([normal(10, 60), popular(11, 50), normal(12, 40)], NOW);
  assert.deepEqual([...matched.matchedNormalIds], ['10'], 'FIFO matching exposes the exact normal application used by observability');
  assert.deepEqual([...matched.matchedPopularIds], ['11'], 'FIFO matching exposes the exact popular application that consumed credit');
  const augustHistory = [
    ...Array.from({ length: 21 }, (_, i) => ({ id: i + 1, event_type: 'normal', event_at: '2026-08-01T08:00:00.000Z' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: i + 22, event_type: 'popular', event_at: '2026-08-02T08:00:00.000Z' })),
  ];
  assert.deepEqual(state(augustHistory), { normalDone: 0, popularUsed: 0, credits: 0, validityDays: 3 },
    'the old 21 minus 5 history does not preserve 16 credits after the retroactive cutoff');

  let params;
  const db = { query: async (_sql, values) => { params = values; return { rows: [{ ...normal(10, 1), phone8: '12345678' }] }; } };
  const loaded = await loadPopularCreditState(db, '12345678', { evaluatedAt: NOW });
  assert.equal(loaded.credits, 1, 'database events use the same calculation');
  assert.equal(new Date(params[0]).toISOString(), ago(72), 'database query starts at the rolling 72-hour cutoff');
  assert.equal(new Date(params[1]).toISOString(), NOW.toISOString(), 'database query does not include future events');
  assert.deepEqual(params[2], ['12345678'], 'credit accounting is isolated by participating identity');
  assert.match(source, /ca\.expires_at > \$2/, 'only currently active popular holds consume credit');
  assert.match(source, /ca\.status = 'blog_pending'/, 'a pending popular application reserves its credit until rejection or cancellation');
  console.log('popularCredit.service: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
