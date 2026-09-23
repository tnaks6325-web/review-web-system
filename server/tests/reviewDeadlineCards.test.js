const assert = require('assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

assert.doesNotMatch(
  page,
  /_reviewDeadlineState|status-badge-deadline|deadline-close-note|제출기한\s*:/,
  'review cards must not calculate or render a submission deadline badge'
);
assert.match(page, /리뷰비 없음/, 'cards must display a review-fee badge even when the fee is zero');
assert.match(page, /return "구매양식반영완료"/, 'pending review cards must identify the reflected purchase form');
assert.match(page, /status-badge-order reflected[^>]*>구매양식반영완료/, 'reflected purchase forms must use one green status badge in the right status area');
assert.doesNotMatch(page, /\$\{prodBadge\}\$\{reflectedBadge\}\$\{revBadge\}/, 'the lower duplicate reflected-purchase badge must not remain in the fee line');
assert.match(page, /rr-row[\s\S]*\$\{badgeHtml\}/, 'the reflected-purchase status must remain in the right status area');
assert.match(page, /\.fee-line\s*\{[^}]*flex-wrap:wrap[^}]*overflow:visible/, 'fee badges must wrap rather than be clipped on narrow cards');

console.log('review card without deadline badge contract passed');
