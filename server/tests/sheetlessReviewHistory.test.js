const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../src/services/search.service.js'), 'utf8');
const start = src.indexOf('async function _mergeOrderSubmissions');
const end = src.indexOf('/**\n * Phase 7', start);
const body = src.slice(start, end);

assert.ok(start >= 0, 'review history order merge is missing');
assert.ok(/LEFT JOIN campaign_applications ca\s+ON ca\.id = os\.campaign_application_id/.test(body),
  'sheetless orders must resolve their campaign through campaign_application_id');
assert.ok(/LEFT JOIN recruit_campaigns rc\s+ON rc\.id = ca\.campaign_id/.test(body),
  'sheetless orders must resolve the campaign title');
assert.ok(/COALESCE\(rc\.title, tc\.campaign_name\)/.test(body),
  'campaign-backed order must have a review history display name without tab_configs');
assert.ok(!/\n\s+JOIN tab_configs tc/.test(body),
  'inner joining tab_configs hides sheetless orders from review history');

console.log('sheetless review history contract passed');
