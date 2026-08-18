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
  /LEFT JOIN campaign_participants cp ON cp\.order_submission_id = os\.id/,
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

console.log('sheetless review earnings contract passed');
