const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modal = read('frontend/js/recruit-modal.js');
const recruit = read('frontend/js/index-recruit.js');
const workOrder = read('frontend/js/work-order-detail.js');

assert(/id="rf_skip_weekends"/.test(modal), '모집공고 편집 팝업에 주말 제외 입력이 있어야 합니다.');
assert(/payload\.skip_weekends\s*=\s*!!document\.getElementById\("rf_skip_weekends"\)\?\.checked/.test(recruit),
  '저장 요청은 주말 제외 값을 전송해야 합니다.');
assert(/rf_skip_weekends[\s\S]{0,180}c\.skip_weekends/.test(recruit),
  '기존 모집공고 재편집 시 주말 제외 값이 복원되어야 합니다.');
assert(/rf_skip_weekends[\s\S]{0,180}prefill\.skip_weekends/.test(recruit),
  '작업오더에서 새 모집공고를 만들 때 주말 제외 값이 프리필되어야 합니다.');
assert(/skip_weekends:\s*o\.skip_weekends === true/.test(workOrder),
  '작업오더 프리필은 원본 주말 제외 값을 유지해야 합니다.');

console.log('recruitWeekendModalContract: passed');
