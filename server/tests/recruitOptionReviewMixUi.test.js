const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modal = read('frontend/js/recruit-modal.js');
const recruit = read('frontend/js/index-recruit.js');

assert.match(modal, /id="rf_review_mix_rows"/);
assert.doesNotMatch(modal, /id="rf_mixed_review_rows"/);
assert.match(recruit, /const RF_REVIEW_MIX_TYPES = \['photo', 'text', 'confirm', 'star'\]/);
assert.match(recruit, /function getRecruitReviewTypeMixByOption\(\)/);
assert.match(recruit, /data-mix-option=/);
assert.match(recruit, /window\._rfReviewMixPending/);
assert.match(recruit, /reviewMixByOption:\s*getRecruitReviewTypeMixByOption\(\)/);
assert.match(recruit, /payload\.review_type_mix = getRecruitReviewTypeMix\(\)/);

console.log('recruitOptionReviewMixUi: 7 passed');
