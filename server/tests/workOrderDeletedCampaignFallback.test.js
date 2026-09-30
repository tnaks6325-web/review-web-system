/**
 * 작업오더의 연결 공고를 삭제한 뒤 [모집공고]를 누르면 빈 수정 모달이 열리던 회귀 가드.
 * 삭제(404)만 새 공고 + 작업오더 프리필로 전환하고, 권한·서버 오류는 중복 공고 생성으로
 * 오인하지 않아야 한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const recruit = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');

assert.match(recruit,
  /res\.status === 404 && prefill[\s\S]{0,240}openRecruitModal\(null, prefill, woOrderId\)/,
  '삭제된 연결 공고(404)만 작업오더 프리필 신규 발행으로 전환한다');
assert.match(recruit,
  /if \(!res\.ok\) \{[\s\S]{0,520}throw new Error\(/,
  '404 외의 조회 실패는 삭제로 오인하지 않고 오류로 남긴다');
assert.match(workdesk,
  /if\(o\.linked_campaign_id\) await openRecruitModal\(o\.linked_campaign_id, _woCampaignPrefill\(o\), id\);/,
  '작업오더의 기존 공고 열기에도 프리필 원본과 역연결 ID를 함께 전달한다');

console.log('✅ workOrderDeletedCampaignFallback: 3개 통과');
