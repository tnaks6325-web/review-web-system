/**
 * 모집공고 수정 모달의 구매채널 복원과 저장 버튼 위치 회귀 방지.
 * 실행: node tests/recruitModalPersistence.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const front = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', file), 'utf8');
const server = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

const modal = front('js/recruit-modal.js');
const recruit = front('js/index-recruit.js');
const routes = server('routes/campaign.routes.js');

assert.match(modal, /id="rf_channel_btns" class="square-toggle"><button class="rchan-btn" data-group="channel" data-val="쿠팡"/,
  '컴팩트 구매채널 버튼은 기존 선택값을 복원할 수 있는 클래스가 있어야 합니다.');
assert.match(recruit, /channel,\s*\n\s*channel_custom: document\.getElementById\("rf_channel_custom"\)\.value\.trim\(\)/,
  '구매채널과 직접입력값은 저장 요청에 함께 포함돼야 합니다.');
assert.match(routes, /channel = COALESCE\(\$3, channel\),\s*\n\s*channel_custom = COALESCE\(\$4, channel_custom\)/,
  '서버 수정 경로는 구매채널과 직접입력값을 함께 보존해야 합니다.');
assert.match(modal, /#recruitModal \.rf-compact-main \.footer\{display:none/,
  '중앙 편집영역의 취소·저장 버튼은 숨겨야 합니다.');
assert.match(modal, /<button type="button" id="recruitSaveBtn" class="rf-savebtn" onclick="saveRecruitPost\(\)">/,
  '저장 상태를 제어하는 버튼은 팝업 우측 하단 버튼 하나여야 합니다.');
assert.doesNotMatch(modal, /id="recruitSaveBtnLegacy"/,
  '별도 하단 저장 버튼 ID를 남기면 상태 제어가 분리됩니다.');

console.log('✅ recruitModalPersistence: 구매채널·저장 버튼 회귀 검사 통과');
