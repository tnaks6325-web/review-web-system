const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../src/routes/reviewer.routes.js'),
  'utf8'
);
const start = source.indexOf("router.get('/review-earnings'");
const end = source.indexOf("router.get('/my-payments'", start);
const body = source.slice(start, end);

assert.ok(start >= 0, 'review earnings route is missing');
assert.match(
  body,
  /FROM order_submissions os[\s\S]*LEFT JOIN campaign_applications ca[\s\S]*LEFT JOIN recruit_campaigns rc/,
  'sheetless order ledger must resolve its linked campaign'
);
assert.match(
  body,
  /substring\(os\.sheet_id from '\^campaign:\(\.\+\)\$'\)/,
  'a sheetless campaign:<id> ledger key must recover the campaign when the application FK is absent'
);
assert.match(
  body,
  /AND \(rc\.id IS NOT NULL OR os\.sheet_id LIKE 'campaign:%'\)/,
  'a sheetless worktable key must remain visible even when its campaign metadata is missing'
);
assert.match(
  body,
  /LEFT JOIN campaign_participants cp\s+ON cp\.order_submission_id = os\.id/,
  'the workboard participant row must be available as the payment amount fallback'
);
assert.match(
  body,
  /extractAmountNumber\(o\.rowJson\)/,
  'workboard payment amount must be used when the legacy ledger price is empty'
);
assert.match(
  body,
  /os\.price[\s\S]*productPrice/,
  'sheetless order price must be used as the reviewer product cost'
);
assert.match(
  body,
  /NOT EXISTS \([\s\S]*FROM review_index ri[\s\S]*ri\.row_index = os\.sheet_row/,
  'a sheet-indexed order must not be counted again as a sheetless order'
);
const dedup = (body.match(/AND NOT EXISTS \(\s*SELECT 1 FROM review_index ri[\s\S]*?\n\s*\)`,/) || [''])[0];
assert.ok(dedup && !/ri\.phone8 = ANY/.test(dedup),
  'owner-UUID rows must deduplicate by the order/participant coordinate even after their phone changes');
assert.match(
  body,
  /cp\.owner_reviewer_id = \$2[\s\S]*cp\.owner_reviewer_id IS NULL[\s\S]*os\.owner_reviewer_id = \$2/,
  'sheetless earnings must treat the current participant owner as authoritative before order ownership'
);
assert.match(
  body,
  /NOT \$3::boolean[\s\S]*COALESCE\(cp\.participant_identity_id, os\.participant_identity_id, ca\.participant_identity_id\) = \$4/,
  'sub-account earnings must stay within the authenticated participant identity'
);

console.log('sheetless review earnings contract passed');
