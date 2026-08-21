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

// 내부 담당자(master/admin/staff)만 사용할 수 있는 별도 명령이어야 한다(광고주·리뷰어 차단).
const routeAt = routes.indexOf("router.post('/workdesk/manual-review-submit'");
assert.ok(routeAt >= 0, '관리자 수동 리뷰제출 라우트가 존재한다');
const routeBlock = routes.slice(routeAt, routeAt + 1400);
// ★ 2026-08 사용자 확정: AE(staff)도 수동 리뷰제출을 한다 — 광고주·리뷰어는 계속 차단.
assert.match(routeBlock, /authMiddleware, internalMiddleware/, '수동 리뷰제출은 내부 담당자만 허용한다');
assert.match(routeBlock, /fileIds/, '첨부된 파일 ID 배열을 필수로 받는다');
assert.match(routeBlock, /manualWorkdeskReviewSubmit/, '라우트가 전용 서비스로 연결된다');

// 그리드에서는 상태 셀을 잠그고, 리뷰제출에만 우클릭 명령을 노출한다.
assert.match(workdesk, /_workdeskStatusKind/, '프런트에서 상태 열을 판별한다');
assert.match(workdesk, /gstatuslock/, '리뷰제출/입금 셀에 잠금 UI를 적용한다');
assert.match(workdesk, /openManualReviewSubmission/, '리뷰제출 우클릭 명령이 수동 제출 모달을 연다');
assert.match(workdesk, /\/api\/image\/review-upload/, '모달은 기존 리뷰 업로드 API를 사용한다');
assert.match(workdesk, /\/api\/trackb\/workdesk\/manual-review-submit/, '업로드 후 전용 제출 API를 호출한다');

/* ── 2026-08-21 사용자 확정 ───────────────────────────────────────────────
   ① 상태 칸 판정의 단일 출처 = 그 탭의 `submit_col`(서버가 `statusCols` 로 실어 준다).
      이름 목록(`_SUBMIT_HEADERS`)만 보던 시절, 헤더가 그냥 `리뷰` 인 탭에서
      **시스템은 그 칸에 제출 시각을 쓰는데 화면은 평범한 칸으로 봐서** 직접 타이핑이 열리고
      [📎 수동 리뷰제출] 은 안 뜨는 상태가 됐다(실측).
   ② 리뷰제출 칸의 주 행동은 편집이 아니라 수동 제출 — 편집 항목을 그 자리에서 대체한다.
   ③ 첨부는 **붙여넣기(+드롭)** 뿐 — 파일 탐색기 창구를 두지 않는다.
   ④ 팝오버는 **셀 옆 인라인**(body 직속) — 중앙 모달로 되돌리지 않는다. */
assert.match(service, /function _statusToggleForRow/, '상태 칸 판정은 그 행의 submit_col 을 먼저 본다');
assert.match(editBlock, /_statusToggleForRow\(field\.slice\(4\), row\)/, '편집 잠금도 같은 판정을 쓴다(이름 목록 사본 금지)');
assert.match(editBlock, /submit_col, submit_col2/, '판정 재료를 잠근 행에서 함께 읽는다');
const tabBlock = service.slice(service.indexOf('async function workdeskTab'), service.indexOf('async function editWorkdeskRow'));
assert.match(tabBlock, /res\.statusCols = \{ submit:/, '내부 응답에 그 탭의 상태 칸 헤더명을 싣는다');
assert.match(workdesk, /STATE\.wd&&STATE\.wd\.statusCols/, '화면은 서버가 준 상태 칸을 우선한다(이름 목록은 폴백)');

const menuBlock = workdesk.slice(workdesk.indexOf('function _openCellMenu'), workdesk.indexOf('function _closeCellMenu'));
assert.match(menuBlock, /isReviewCell\s*\n?\s*\?\s*row\('📎'/, '리뷰제출 칸에서는 편집 항목 대신 수동 제출을 그린다');
assert.match(menuBlock, /reviewBlockReason/, '못 누르는 사유(이미 제출·권한)를 흐린 항목 + 툴팁으로 말한다');

const popBlock = workdesk.slice(workdesk.indexOf('const _MR_MAX_FILES'), workdesk.indexOf('async function _manualReviewDateOnly'));
assert.doesNotMatch(popBlock, /type=\\?["']file["']/, '파일 탐색기 창구를 두지 않는다(사용자 확정)');
assert.doesNotMatch(popBlock, /manualreviewinput/, '옛 파일선택 input 흔적이 남지 않는다');
assert.doesNotMatch(popBlock, /class="modalov"|modalbox/, '중앙 모달로 되돌리지 않는다(셀 옆 인라인)');
assert.match(popBlock, /addEventListener\('paste'/, '붙여넣기로 첨부한다');
assert.match(popBlock, /_manualReviewTake/, '붙여넣기·드롭이 한 함수로 수렴한다(사본 금지)');
assert.match(popBlock, /getBoundingClientRect/, '누른 셀을 앵커로 배치한다');
assert.match(popBlock, /document\.body\.appendChild/, '팝오버는 body 직속(표는 가로 스크롤 컨테이너)');
assert.match(popBlock, /window\._wdRevPopBound/, '전역 리스너는 최상위 1회만 건다');
assert.match(popBlock, /onclick="_manualReviewDrop\(\$\{i\}\)"/, 'onclick 에는 인덱스만 넘긴다');
// 되돌릴 수 없는 처리라 붙여넣기만으로 자동 제출하지 않는다 — [제출 처리] 한 번을 남긴다.
assert.match(popBlock, /_manualReviewSubmit\(\)/, '제출은 사람이 누른다');
const takeFn = popBlock.match(/function _manualReviewTake\(list\)\{[\s\S]*?\n\}/)[0];
assert.doesNotMatch(takeFn, /_manualReviewSubmit/,
  '붙여넣는 즉시 자동 제출하지 않는다(오붙여넣기 = 되돌릴 수 없는 확정)');

console.log('workdeskManualReviewSubmit.test.js: OK');
