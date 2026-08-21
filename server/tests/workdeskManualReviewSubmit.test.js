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

/* ── 2026-08-21 실측 `submit_column_missing` ────────────────────────────────
   수동·작업표로 추가한 줄은 `campaign_participants.submit_col` 이 비어 있다(그 칸은
   `review_index` 복제 경로에서만 채워진다). 상태 칸은 **탭 단위 속성**이라 그 줄만
   제출을 못 하는 것은 사실과 다르다 → 탭 감지값으로 보완하되, 그래도 없으면 거부. */
assert.match(service, /statusHeaderForTab\(client, \{ sheetId, tabName, kind: 'submit' \}\)/,
  '줄에 값이 없으면 그 탭의 감지값으로 보완한다(잠근 tx 라 client 로 조회)');
assert.match(read('src/services/sheetlessStatus.service.js'), /^\s*statusHeaderForTab,$/m,
  '해석기는 무시트 상태 기록과 같은 것을 쓴다(사본 금지)');
assert.match(manualBlock, /submit_column_missing/, '그래도 못 찾으면 거부한다(추측 기입 금지)');
assert.match(workdesk, /submit_column_missing:'이 작업표에 리뷰제출 열이 없습니다/,
  '화면은 오류 코드가 아니라 무엇을 해야 하는지를 말한다');
assert.match(workdesk, /_MR_ERR\[k\] \|\|/, '모르는 코드는 원문을 남긴다(뭉뚱그리지 않는다)');

// 스텁 pool 로 실제 실행 — 줄 값 우선 · 탭 폴백 · fail-closed 세 갈래.
(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
  const svc = require('../src/services/trackB.service');
  const FID = 'FILE1234567890';
  const mk = (part, tabCol) => {
    const client = {
      async query(sql) {
        const q = String(sql).replace(/\s+/g, ' ');
        if (/^BEGIN|^ROLLBACK|^COMMIT/.test(q)) return { rows: [] };
        if (/FROM campaign_participants WHERE id=\$1/.test(q)) return { rows: [part] };
        if (/FROM review_index WHERE sheet_id = \$1 AND tab_name = \$2 AND COALESCE/.test(q)) return { rows: tabCol ? [{ h: tabCol }] : [] };
        if (/SELECT is_submitted FROM review_index/.test(q)) return { rows: [{ is_submitted: false }] };
        if (/FROM review_submissions/.test(q)) return { rows: [{ file_id: FID }] };
        if (/UPDATE campaign_participants/.test(q)) return { rows: [{ submit_value: '8/21 15:00' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    return { async connect() { return client; } };
  };
  const base = { id: 'p1', seq: 444, reviewer_name: '최은지', submit_col: null, is_submitted: false,
    source: 'manual', order_submission_id: null, identity_key: null, phone8: '0402',
    recipient_name: '최은지', option_text: null, row_json: {} };
  const call = () => svc.manualWorkdeskReviewSubmit({ sheetId: 's', tabName: 'T', rowId: 'p1', fileIds: [FID] });

  svc.__setPoolForTest(mk(base, '리뷰제출'));
  let r = await call();
  assert.equal(r.ok, true, '수동 줄도 탭 감지값으로 제출된다: ' + r.error);
  assert.equal(r.submitColumn, '리뷰제출');

  svc.__setPoolForTest(mk(base, ''));
  r = await call();
  assert.equal(r.error, 'submit_column_missing', '탭에도 리뷰제출 열이 없으면 거부(fail-closed)');

  svc.__setPoolForTest(mk({ ...base, submit_col: '리뷰' }, '리뷰제출'));
  r = await call();
  assert.equal(r.submitColumn, '리뷰', '줄이 들고 있는 값이 탭 폴백을 이긴다');

  console.log('workdeskManualReviewSubmit.test.js: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
