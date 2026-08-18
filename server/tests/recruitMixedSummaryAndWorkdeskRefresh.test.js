const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const recruit = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');

assert.match(recruit, /function _reviewMixTotalLabel\(sum, expected, optionMode\)/,
  '혼합 리뷰 요약은 옵션 여부에 따라 기준 인원 라벨을 분리해야 합니다.');
assert.match(recruit, /optionMode\s*\? `합계 \$\{sum\}명 \/ 옵션인원 \$\{expected\}명`\s*:\s*`합계 \$\{sum\}명 \/ 총모집인원 \$\{expected\}명`/,
  '옵션 없는 작업은 총모집인원을 기준으로 표시해야 합니다.');
assert.match(recruit, /window\.loadRecruitList = loadRecruitList;/,
  '공용 목록 로더는 workdesk 런타임에서 명시적으로 사용할 수 있어야 합니다.');
assert.match(workdesk, /if\s*\(typeof window\.loadRecruitList === 'function'\)\s*await window\.loadRecruitList\(\)/,
  '모집공고 화면은 로더가 준비되지 않은 경우에도 저장 완료 흐름을 깨지 않아야 합니다.');

console.log('recruitMixedSummaryAndWorkdeskRefresh: passed');
