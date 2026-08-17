/** 작업오더/저장 공고의 혼합 리뷰 구성이 동적 UI에 복원되는지 확인하는 가상 회귀 테스트. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeReviewTypeMix, validateReviewTypeMix } = require('../src/utils/reviewTypeMix');

const root = path.join(__dirname, '..', '..');
const recruit = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');
const mix = [{ type: 'photo', quantity: 30 }, { type: 'text', quantity: 20 }];

const normalized = normalizeReviewTypeMix(mix);
assert.deepStrictEqual(normalized.mix, mix, '가상 작업오더 혼합값이 정규화 후에도 보존되어야 합니다.');
assert.strictEqual(validateReviewTypeMix('mixed', normalized, 50, { requireWhenMixed: true }), null,
  '가상 혼합 구성은 총인원과 일치하면 서버 저장을 통과해야 합니다.');

const editStart = recruit.indexOf('const savedReviewMix');
const prefillStart = recruit.indexOf('const prefillReviewMix');
const edit = recruit.slice(editStart, recruit.indexOf('/* 💸 086', editStart));
const prefill = recruit.slice(prefillStart, recruit.indexOf('/* ★ 065: 연결 탭 자동 선택', prefillStart));
for (const [name, block] of [['수정 프리필', edit], ['작업오더 프리필', prefill]]) {
  assert(block.indexOf('_setRecruitGlobalReviewTypeMix') >= 0, `${name}: 혼합 원본을 보관해야 합니다.`);
  assert(block.indexOf('_setRecruitGlobalReviewTypeMix') < block.indexOf('_rfPickBtn'), `${name}: 원본 보관 후 혼합 UI를 렌더해야 합니다.`);
}
assert.match(recruit, /function _setRecruitGlobalReviewTypeMix\(mix\)/, '동적 혼합 UI의 단일 프리필 함수가 필요합니다.');
assert.match(recruit, /window\._rfGlobalReviewTypeMix = \[\];/, '새 모달에서 이전 공고 혼합값이 누수되면 안 됩니다.');
assert.match(recruit, /root\.style\.display = visible \? '' : 'none'/, '단일 타입 전환은 혼합 입력을 지우지 않고 숨겨야 합니다.');

console.log('recruitReviewTypeMixRestore: virtual pass');
