const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '104_campaign_weekend_publication.sql'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src', 'routes', 'campaign.routes.js'), 'utf8');

function ok(message, condition) {
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

ok('campaign stores the weekend rule independently of a worktable',
  /ADD COLUMN IF NOT EXISTS skip_weekends BOOLEAN/.test(migration)
  && /effectiveSkipWeekends/.test(route));
ok('card projection reports the weekend unpublished state from the shared policy',
  /state: weekend\.blocked \? 'weekend_unpublished' : st\.state/.test(route)
  && /stateMessage: weekend\.blocked \? weekend\.message/.test(route));
ok('participation gate uses the shared policy with the saved daily plan',
  /reason: weekend\.reason/.test(route)
  && /weekendPublicationState\(camp, now, countsMap\.get\(id\) && countsMap\.get\(id\)\.plans\)/.test(route));

console.log('campaignWeekendIntegration: passed');
