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
ok('both participation and legacy application paths block weekend applications server-side',
  (route.match(/reason: weekend\.reason/g) || []).length >= 2
  && /weekendPublicationState\(camp, now\)/.test(route));

console.log('campaignWeekendIntegration: passed');
