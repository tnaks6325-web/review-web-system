const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/reviewer.routes.js'), 'utf8');
const fnStart = page.indexOf('function _reviewDeadlineState');
const fnEnd = page.indexOf('async function _loadReviewEarnings', fnStart);

assert.ok(fnStart >= 0, 'review deadline state helper is missing');
assert.ok(fnEnd > fnStart, 'review deadline helper boundary is missing');

const sandbox = {};
vm.runInNewContext(page.slice(fnStart, fnEnd), sandbox);

const state = (purchaseDate, now) => JSON.parse(JSON.stringify(sandbox._reviewDeadlineState(purchaseDate, now)));

assert.deepStrictEqual(
  state('2026-08-01', new Date('2026-08-03T12:00:00+09:00')),
  { remaining: 28, tone: 'good', notice: '' },
  '20일 이상 남은 제출기한은 녹색이어야 한다'
);
assert.deepStrictEqual(
  state('2026-08-01', new Date('2026-08-17T12:00:00+09:00')),
  { remaining: 14, tone: 'warn', notice: '' },
  '10~19일 남은 제출기한은 대기색이어야 한다'
);
assert.deepStrictEqual(
  state('2026-08-01', new Date('2026-08-23T12:00:00+09:00')),
  { remaining: 8, tone: 'danger', notice: '' },
  '9일 이하 제출기한은 붉은색이어야 한다'
);
assert.deepStrictEqual(
  state('2026-08-01', new Date('2026-08-27T12:00:00+09:00')),
  { remaining: 4, tone: 'danger', notice: '4일 뒤 작업종료 · 페이백 불가' },
  '5일 이하에는 작업종료·페이백 불가 경고가 있어야 한다'
);
assert.match(route, /purchaseDate/, 'review-earnings API must provide the purchase date for each card');
assert.match(page, /리뷰비 없음/, 'cards must display a review-fee badge even when the fee is zero');
assert.match(page, /return "구매양식반영완료"/, 'pending review cards must identify the reflected purchase form');

console.log('review deadline card contract passed');
