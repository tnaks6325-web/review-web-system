/** 리뷰내역의 같은 캠페인 다건 제출이 한 폼으로 묶이지 않는지 고정한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
const start = src.indexOf('function _partInfoRenderBtns(');
const end = src.indexOf('/* ═══ 🚫 주문취소', start);
const buttons = src.slice(start, end);
const submitStart = src.indexOf('function _partInfoSubmit(index)');
const submitEnd = src.indexOf('\n}', submitStart) + 2;
const submit = src.slice(submitStart, submitEnd);

assert(start >= 0 && end > start, '리뷰 제출 버튼 렌더 구간을 찾지 못했습니다');
assert(submitStart >= 0 && submitEnd > submitStart, '독립 제출 함수 구간을 찾지 못했습니다');
assert.match(buttons, /submitItems\.map\(\(x, i\)/, '다건은 참여 건별 선택 버튼을 렌더해야 합니다');
assert.match(buttons, /_partInfoSubmit\(' \+ i \+ '\)/, '각 선택 버튼은 자신의 인덱스만 전달해야 합니다');
assert.doesNotMatch(buttons, /onclick="_partInfoSubmit\(\)"/, '다건 전체 제출 버튼이 남아 있으면 안 됩니다');
assert.match(submit, /Number\.isInteger\(i\)/, '잘못된 선택 인덱스는 제출하면 안 됩니다');
assert.match(submit, /goToSubmit\(\[items\[i\]\]\)/, '제출 화면에는 선택한 한 건만 전달해야 합니다');
assert.doesNotMatch(submit, /goToSubmit\(items\)/, '전체 배열을 제출 화면으로 전달하면 안 됩니다');

console.log('✅ reviewHistoryIndependentSubmit: 다건 카드의 독립 제출 경로 통과');
