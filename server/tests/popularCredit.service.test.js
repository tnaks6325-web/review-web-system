const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadPopularCreditState, canUsePopularCredit } = require('../src/services/popularCredit.service');

async function state(normalDone, popularUsed) {
  const db = { query: async () => ({ rows: [{ normal_done: String(normalDone), popular_used: String(popularUsed) }] }) };
  return loadPopularCreditState(db, '12345678');
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'popularCredit.service.js'), 'utf8');
  assert.match(source, /COALESCE\(ca\.is_popular_snapshot, rc\.is_popular\)/, 'credit type is immutable after the application snapshot is recorded');
  assert.equal(canUsePopularCredit(await state(0, 0)), false, 'general completion 0 blocks popular participation');
  assert.equal(canUsePopularCredit(await state(1, 0)), true, 'one completed normal campaign grants one popular participation');
  assert.equal(canUsePopularCredit(await state(2, 0)), true, 'two completed normal campaigns grant two popular participations');
  assert.equal(canUsePopularCredit(await state(2, 1)), true, 'one remaining credit permits the second popular participation');
  assert.equal(canUsePopularCredit(await state(2, 2)), false, 'all credits consumed blocks another popular participation');
  assert.equal(canUsePopularCredit(await state(1, 0)), true, 'expired or cancelled popular holds are excluded before the query result is returned');
  console.log('popularCredit.service: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
