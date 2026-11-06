'use strict';
/* 동시진행 1차 운영 범위(사용자 확정 2026-11-06 「1번 시작」).
   드문 경우 — 구매사진 교체·복원, 리뷰 파일 이동·되돌리기·자동분류 기록, 중복파일 수동·자동 제거,
   리뷰 사진 교체 — 는 동시진행 주문에서 막고 담당자가 따로 처리한다. 기능 코드는 남겨 두고 2차에 하나씩 연다.
   ★ 준비 상태(dualChannelRuntime)와 별개다 — 준비가 모두 켜져도 여기는 닫혀 있다. */
const DUAL_PHASE1_MANUAL = 'dual_phase1_manual';
const DUAL_PHASE1_MESSAGE = '동시진행 주문은 1차 운영에서 이 기능을 쓸 수 없습니다. 담당자가 따로 처리해 주세요.';

function phase1ManualResult(extra = {}) {
  return { ok: false, error: DUAL_PHASE1_MANUAL, code: DUAL_PHASE1_MANUAL, message: DUAL_PHASE1_MESSAGE, ...extra };
}

/* 결정 344 — 외부모집 수동제출(관리자 대리 입력)은 동시진행 작업표·공고에 보통 주문 1건을 넣지 않는다.
   관리자 대리 「묶음」 제출 입구가 생기면 그 입구로만 연다(이 거절을 완화하지 않는다).
   ★ 화면(frontend/js/manual-order.js)은 서버의 `error` 문구를 그대로 alert 한다 → error 에 사람 문구를 싣는다
     (phase1ManualResult 는 error 에 코드를 싣는다 — 그 관례를 따르면 화면에 코드 문자열이 뜬다). */
const DUAL_MANUAL_UNSUPPORTED = 'dual_channel_manual_unsupported';
const DUAL_MANUAL_UNSUPPORTED_MESSAGE = '이 작업은 네이버·쿠팡 동시진행이라 수동제출로 접수할 수 없어요 — 리뷰어가 구매양식 링크로 두 곳을 함께 내야 해요.';
const DUAL_MANUAL_CHECK_FAILED = 'dual_channel_manual_check_failed';
const DUAL_MANUAL_CHECK_FAILED_MESSAGE = '네이버·쿠팡 동시진행 작업인지 확인하지 못해 접수하지 않았어요 — 잠시 뒤 다시 시도해 주세요(아무것도 기록되지 않았어요).';

function manualDualUnsupportedResult(extra = {}) {
  return { ok: false, code: DUAL_MANUAL_UNSUPPORTED, error: DUAL_MANUAL_UNSUPPORTED_MESSAGE, message: DUAL_MANUAL_UNSUPPORTED_MESSAGE, ...extra };
}
function manualDualCheckFailedResult(extra = {}) {
  return { ok: false, code: DUAL_MANUAL_CHECK_FAILED, error: DUAL_MANUAL_CHECK_FAILED_MESSAGE, message: DUAL_MANUAL_CHECK_FAILED_MESSAGE, ...extra };
}

module.exports = { DUAL_PHASE1_MANUAL, DUAL_PHASE1_MESSAGE, phase1ManualResult,
  DUAL_MANUAL_UNSUPPORTED, DUAL_MANUAL_UNSUPPORTED_MESSAGE, DUAL_MANUAL_CHECK_FAILED, DUAL_MANUAL_CHECK_FAILED_MESSAGE,
  manualDualUnsupportedResult, manualDualCheckFailedResult };
