/**
 * Approved compact editor parity contract.
 *
 * The current shared modal must use the same three-step information structure
 * as the approved compact-rows mockup.  Data-bearing controls remain in the
 * DOM; only the navigation and density change.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const reference = path.join(root, 'frontend', 'mockups', 'recruit-popup-compact-rows.html');

assert(fs.existsSync(reference), 'Approved compact-rows reference must remain versioned with the runtime.');
assert(/class="modal-box rf-box"[^>]*max-width:1020px/.test(modal),
  'The runtime modal must use the approved 1020px desktop width.');

['link', 'prod', 'cond'].forEach((step) => {
  assert(modal.includes(`data-rf-step="${step}"`), `The ${step} rail step must remain available.`);
});
['fee', 'work'].forEach((step) => {
  assert(!modal.includes(`data-rf-step="${step}"`), `${step} must not be a separate rail step.`);
});

assert(modal.includes('진행상품 · 상품 정보'),
  'Product and product information must be represented as one rail section.');
assert(/if \(act === 'pub' \|\| act === 'fee'\) act = 'link'/.test(modal),
  'Scrolling through fee rows must keep the connection rail step active.');
assert(/if \(act === 'work'\) act = 'prod'/.test(modal),
  'Scrolling through work rows must keep the merged product rail step active.');
assert(/#recruitModal \.rf-hrow\{grid-template-columns:minmax\(112px,25%\) minmax\(0,75%\)/.test(modal),
  'Compact rows must preserve the approved 25/75 label-to-control ratio.');
assert(/function hydrateParityControls\(\)/.test(modal),
  'The actual shared runtime modal must hydrate the approved compact controls, not only the static mockup.');
assert(/\['실배송', '빈박스', '택배발송대행'\]/.test(modal),
  'Delivery choices must remain the approved square-toggle order.');
assert(/rf-parity-time-row/.test(modal),
  'Purchase time must be relocated into the connection rows without changing its original field IDs.');
assert(/rf-parity-date-row/.test(modal),
  'The recruitment-start date must be a row-level interactive control below the team chat row.');
['상품 메인 URL', '공고 썸네일 URL', '모집이월 방식', '입금명', '자율리뷰'].forEach((label) => {
  assert(modal.includes(label), `The approved label "${label}" must be present in the runtime modal.`);
});

console.log('recruitModalCompactParity: passed');
