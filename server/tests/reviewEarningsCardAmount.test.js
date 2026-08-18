const assert = require('assert');
const fs = require('fs');
const path = require('path');

const search = fs.readFileSync(path.join(__dirname, '../src/services/search.service.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const mergeStart = search.indexOf('async function _mergeOrderSubmissions');
const mergeEnd = search.indexOf('/**\n * Phase 7', mergeStart);
const merge = search.slice(mergeStart, mergeEnd);
const feeStart = page.indexOf('function _feeForItem');
const feeEnd = page.indexOf('async function _loadReviewEarnings', feeStart);
const fee = page.slice(feeStart, feeEnd);

assert.ok(mergeStart >= 0, 'sheetless review history merge is missing');
assert.match(
  merge,
  /orderSubmissionId:\s*o\.id/,
  'a sheetless review card must retain its order submission id'
);
assert.match(
  fee,
  /item\.orderSubmissionId[\s\S]*order\|\|/,
  'the earnings card must resolve sheetless prices by order submission id'
);

console.log('review earnings card amount contract passed');
