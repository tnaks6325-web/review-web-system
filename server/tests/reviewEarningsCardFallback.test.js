const assert = require('assert');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/reviewer.routes.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const routeStart = route.indexOf("router.get('/review-earnings'");
const routeEnd = route.indexOf("router.get('/my-payments'", routeStart);
const body = route.slice(routeStart, routeEnd);
const feeStart = page.indexOf('function _feeForItem');
const feeEnd = page.indexOf('async function _loadReviewEarnings', feeStart);
const fee = page.slice(feeStart, feeEnd);

assert.ok(routeStart >= 0, 'review earnings route is missing');
assert.match(
  body,
  /sheetlessFallbackCounts[\s\S]*count === 1/,
  'a work-level fallback must only be exposed when there is one unambiguous order'
);
assert.match(
  body,
  /items\[fallbackKey \+ '\|\|order'\]/,
  'the unambiguous order must be indexed by its work key'
);
assert.match(
  fee,
  /\+ '\|\|order'\] \|\| null/,
  'a legacy review-index card must fall back to its work-level order amount'
);
assert.match(
  body,
  /campaignId = campMap\[`\$\{r\.sheetId\}\|\|\$\{r\.tabName\}`\]\?\.id[\s\S]*items\[rowKey\] = fallback\.value/,
  'legacy rows with a different work key must receive the unambiguous campaign order amount'
);
assert.match(
  body,
  /row_json AS "rowJson"/,
  'a workboard row must expose its recorded order data to the earnings calculation'
);
assert.match(
  body,
  /const price = Object\.prototype\.hasOwnProperty\.call\(priceMap, pk\) \? priceMap\[pk\] : extractAmountNumber\(r\.rowJson\);/,
  'the workboard payment amount must remain the fallback after old ledger cleanup'
);

console.log('review earnings card fallback contract passed');
