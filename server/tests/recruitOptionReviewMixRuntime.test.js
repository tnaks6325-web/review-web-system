const assert = require('assert');
const fs = require('fs');
const path = require('path');

const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const recruit = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');
const compactStart = modal.indexOf('<div class="rf-main rf-compact-main">');
const compactEnd = modal.indexOf('</div><!-- /rf-compact-main -->', compactStart);
const compact = modal.slice(compactStart, compactEnd);

assert.ok(compactStart >= 0 && compactEnd > compactStart, '실제 컴팩트 편집기 범위를 찾는다');
assert.match(compact, /id="rf_mixed_review_composer"/);
assert.match(compact, /id="rf_review_mix_rows"/);
assert.doesNotMatch(compact, /id="rf_mixed_review_rows"/);
assert.doesNotMatch(compact, /리뷰 조합/);
assert.match(compact, /id="rf_review_mix_total" hidden/);
assert.match(recruit, /const composer = document\.getElementById\('rf_mixed_review_composer'\)/);
assert.match(recruit, /composer\.hidden = !visible/);

console.log('recruitOptionReviewMixRuntime: 8 passed');
