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

module.exports = { DUAL_PHASE1_MANUAL, DUAL_PHASE1_MESSAGE, phase1ManualResult };
