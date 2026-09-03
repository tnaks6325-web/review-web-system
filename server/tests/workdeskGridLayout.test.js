const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workdesk = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

assert.match(workdesk, /function _gridDefaultFreezeUpto\(headers\)/,
  '수취인 고정 기본값을 계산하는 단일 함수가 필요합니다.');
assert.match(workdesk, /수취인\(\?:명\)\?/,
  '수취인명도 수취인 열의 호환 별칭으로 취급해야 합니다.');
assert.match(workdesk, /기본\(수취인까지\)/,
  '고정열 기본값은 수취인까지라고 표시해야 합니다.');
assert.match(workdesk, /const freezeUpto=STATE\.freezeUpto==null\?defaultFreeze:STATE\.freezeUpto;/,
  '사용자가 별도로 고르지 않았을 때 수취인까지 고정해야 합니다.');
assert.match(workdesk, /max-height:calc\(100vh - 210px - var\(--tbh\)\)/,
  '작업표 스크롤 영역은 더 많은 행을 보이도록 확장해야 합니다.');

console.log('workdeskGridLayout.test.js passed');
