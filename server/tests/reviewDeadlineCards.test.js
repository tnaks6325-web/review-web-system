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
// 결정 371: 반영이 끝난 카드 = 할 일을 말하는 「리뷰 제출 필요」(파란 todo 배지) · 단건·다건 같은 함수 — 의미 그대로("오른쪽 상태 자리의 배지 하나").
assert.match(page, /return \{ text:'리뷰 제출 필요'/, 'pending review cards must identify the reflected purchase form');
assert.match(page, /status-badge-order \$\{st\.tone\}/, 'reflected purchase forms must use one status badge in the right status area');
assert.doesNotMatch(page, /\$\{prodBadge\}\$\{reflectedBadge\}\$\{revBadge\}/, 'the lower duplicate reflected-purchase badge must not remain in the fee line');
assert.match(page, /rr-row[\s\S]*\$\{badgeHtml\}/, 'the reflected-purchase status must remain in the right status area');
assert.match(page, /\.fee-line\s*\{[^}]*flex-wrap:wrap[^}]*overflow:visible/, 'fee badges must wrap rather than be clipped on narrow cards');

console.log('review card without deadline badge contract passed');
