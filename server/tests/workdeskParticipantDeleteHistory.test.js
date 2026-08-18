'use strict';

// 작업보드 참여자 행 삭제는 화면만 숨기는 기능이 아니다.
// 같은 참여의 리뷰어 내역까지 빠져야 하며, 다른 행/다른 작업을 건드리면 안 된다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serviceSrc = fs.readFileSync(path.join(root, 'src/services/trackB.service.js'), 'utf8');
const reviewerSrc = fs.readFileSync(path.join(root, 'src/routes/reviewer.routes.js'), 'utf8');
const workdeskSrc = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');

const block = serviceSrc.slice(
  serviceSrc.indexOf('async function hideWorkdeskRow'),
  serviceSrc.indexOf('// 주문이 연결된 한 행을 안전하게 취소한다.')
);

assert.match(block, /FOR UPDATE/, '삭제 대상 참여행을 잠가 동시 삭제를 직렬화한다');
assert.match(block, /SET deleted_at=NOW\(\), active=FALSE/, '참여행은 작업표에서 논리 삭제한다');
assert.match(block, /__workdesk_deleted/, '재투영 뒤에도 삭제 행이 되살아나지 않도록 삭제 표식을 남긴다');
assert.match(block, /DELETE FROM participation_links[\s\S]*?sheet_id=\$1 AND tab_name=\$2 AND row_index=\$3/, '삭제한 정확한 행의 신원 링크만 제거한다');
assert.match(block, /WHERE order_submission_id=\$1::uuid AND status IN \('applied','submitted'\)/, '연결된 구매양식의 참여상태만 취소한다');
assert.doesNotMatch(block, /DELETE FROM order_submissions/, '주문 원장은 감사용으로 보존한다');
assert.match(block, /participant_history_removed/, '삭제 결과가 참여이력 제거임을 호출부에 명시한다');

// 내 참여현황의 두 원천(review_index + order_submissions) 모두 삭제된 작업표 행을 제외한다.
assert.match(reviewerSrc, /FROM review_index ri[\s\S]*?NOT EXISTS \([\s\S]*?campaign_participants cp[\s\S]*?cp\.seq=ri\.row_index AND cp\.deleted_at IS NOT NULL/, '시트형 참여내역이 삭제 행을 다시 노출하지 않는다');
assert.match(reviewerSrc, /FROM order_submissions os[\s\S]*?os\.deleted_at IS NULL[\s\S]*?campaign_participants cp[\s\S]*?cp\.order_submission_id=os\.id AND cp\.deleted_at IS NOT NULL/, 'DB 주문형 참여내역도 삭제 행을 다시 노출하지 않는다');
assert.match(reviewerSrc, /ca\.status <> 'cancelled'/, '참여 신청 이력에서도 취소된 행을 제외한다');
assert.match(workdeskSrc, /작업표와 리뷰어 참여내역에서 제거/, '관리자 확인문구가 실제 삭제 범위를 안내한다');

const importSrc = fs.readFileSync(path.join(root, 'src/services/participants.service.js'), 'utf8');
assert.match(importSrc, /__workdesk_deleted[\s\S]*?THEN campaign_participants\.deleted_at/, '재임포트 UPSERT가 작업보드 삭제 표식을 보존한다');

console.log('workdeskParticipantDeleteHistory.test.js: OK');
