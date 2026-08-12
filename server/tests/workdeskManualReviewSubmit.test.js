'use strict';

// 관리자 수동 리뷰제출 회귀 가드.
// 실행: node tests/workdeskManualReviewSubmit.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const service = read('src/services/trackB.service.js');
const routes = read('src/routes/trackB.routes.js');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend', 'workdesk.html'), 'utf8');

// 상태값은 일반 셀 편집 API로 우회할 수 없어야 한다.
const editBlock = service.slice(service.indexOf('async function editWorkdeskRow'), service.indexOf('async function revertWorkdeskEdit'));
assert.doesNotMatch(service.match(/const _EDIT_FIELD_KIND = \{[\s\S]*?\n\};/)[0], /is_submitted:\s*'bool'/, '리뷰제출 상태는 일반 편집 화이트리스트에서 제외한다');
assert.doesNotMatch(service.match(/const _EDIT_FIELD_KIND = \{[\s\S]*?\n\};/)[0], /is_paid:\s*'bool'/, '입금 상태는 일반 편집 화이트리스트에서 제외한다');
assert.match(editBlock, /status_column_locked/, '리뷰제출/입금 헤더 직접 편집을 서비스에서도 거부한다');

// 수동 제출은 잠긴 행과, 그 행에 방금 업로드되어 원장에 있는 파일을 함께 검증한다.
assert.match(service, /async function manualWorkdeskReviewSubmit/, '수동 리뷰제출 서비스가 존재한다');
const manualBlock = service.slice(service.indexOf('async function manualWorkdeskReviewSubmit'), service.indexOf('async function hideWorkdeskRow'));
assert.match(manualBlock, /FOR UPDATE/, '동일 행의 동시 수동 제출을 직렬화한다');
assert.match(manualBlock, /FROM review_submissions/, '업로드 원장에서 파일 소유를 검증한다');
assert.match(manualBlock, /slot_key\s*=\s*'review'/, '리뷰 슬롯 파일만 제출 증빙으로 허용한다');
assert.match(manualBlock, /UPDATE review_index SET is_submitted = TRUE/, '리뷰 내역 상태를 제출 완료로 반영한다');
assert.match(manualBlock, /is_submitted=TRUE/, '작업보드 참여자 상태도 제출 완료로 반영한다');

// 관리자/마스터만 사용할 수 있는 별도 명령이어야 한다.
const routeAt = routes.indexOf("router.post('/workdesk/manual-review-submit'");
assert.ok(routeAt >= 0, '관리자 수동 리뷰제출 라우트가 존재한다');
const routeBlock = routes.slice(routeAt, routeAt + 1400);
assert.match(routeBlock, /authMiddleware, adminOrMasterMiddleware/, '수동 리뷰제출은 관리자/마스터만 허용한다');
assert.match(routeBlock, /fileIds/, '첨부된 파일 ID 배열을 필수로 받는다');
assert.match(routeBlock, /manualWorkdeskReviewSubmit/, '라우트가 전용 서비스로 연결된다');

// 그리드에서는 상태 셀을 잠그고, 리뷰제출에만 우클릭 명령을 노출한다.
assert.match(workdesk, /_workdeskStatusKind/, '프런트에서 상태 열을 판별한다');
assert.match(workdesk, /gstatuslock/, '리뷰제출/입금 셀에 잠금 UI를 적용한다');
assert.match(workdesk, /openManualReviewSubmission/, '리뷰제출 우클릭 명령이 수동 제출 모달을 연다');
assert.match(workdesk, /\/api\/image\/review-upload/, '모달은 기존 리뷰 업로드 API를 사용한다');
assert.match(workdesk, /\/api\/trackb\/workdesk\/manual-review-submit/, '업로드 후 전용 제출 API를 호출한다');

console.log('workdeskManualReviewSubmit.test.js: OK');
