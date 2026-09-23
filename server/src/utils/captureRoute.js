/**
 * captureRoute.js — 제출 이미지 자동 분류·이동(파일 라우팅) 전이표·모드 단일 출처.
 *
 * "리뷰 칸에 현금영수증 / 영수증 칸에 리뷰 / 리뷰 칸에 구매캡처"를 감지해
 * 올바른 폴더로 옮기는 기능의 **판정 규칙이 전부 여기 있다**(순수함수 — DB·Drive 미접근).
 * 실행부는 services/fileRoute.service.js, 배선은 diag.routes.js /review-upload.
 * 와이어프레임: frontend/docs/리뷰제출_이미지_자동분류_와이어프레임.html
 *
 * ★★ 완화 금지 3종:
 *   ① 이동은 이 전이표에 정의된 조합만 — 표 밖(other·purchase_confirm 판정, 대상 폴더 없음)은
 *      전부 "아무것도 안 함"(현행 경고 유지). 확인 불가 = 옮기지 않음.
 *   ② 이동의 근거는 verdict.sure(확신 ≥ CAPTURE_VERIFY_SURE_CONFIDENCE 0.9)뿐 —
 *      애매(0.7~0.9)는 종전처럼 경고만 한다.
 *   ③ **반려(제출 거절)의 조건은 이 파일에 없다** — 반려의 유일한 근거는 SHA-256 정확 일치
 *      (fileRoute.service.findSlotDuplicate)이고, AI 판정만으로는 절대 반려하지 않는다.
 *
 * ★ 구매캡처(order_capture) 이동은 **판별 예시 2장(구매캡처+구매확정)이 모두 등록**돼야
 *   발동한다(사용자 확정 2026-08-05 — "예시를 미리 등록해놓아서 구분기준을 명확히").
 *   주문내역·구매확정 화면은 생김새가 비슷해 예시 없는 판정은 신뢰하지 않는다.
 * ★ 카카오메이커스는 전체 제외 — 별점 없는 피드형 화면이 공존해 리뷰 판정 자체가
 *   흔들리는 채널이다(1차 필터 REVIEW_PRECHECK_EXEMPT와 같은 판단).
 */

/** 전이표: `${제출슬롯}>${AI판정 kind}` → 이동 목적지.
 *  toSlot = 원장 slot_key 에 기록할 값 / target = 폴더 종류(review|receipt|capture) */
const ROUTE_TRANSITIONS = {
  'review>receipt':        { toSlot: 'receipt',       target: 'receipt', needsReceiptSlot: true },
  'review>order_capture':  { toSlot: 'order_capture', target: 'capture', needsRouteSamples: true },
  'receipt>review':        { toSlot: 'review',        target: 'review' },
  'receipt>order_capture': { toSlot: 'order_capture', target: 'capture', needsRouteSamples: true },
};

const EXEMPT_CHANNELS = ['kakao'];

/**
 * 동작 모드 — env AUTO_FILE_ROUTE.
 *   'off'(0) = 완전 끔 / 'dry'(기본) = 관측(판정·계획만 기록, 이동 0) / 'auto'(1) = 자동 이동.
 * 기본값이 dry 인 이유: 사용자 확정 "관측결과 1회 수행 후 출시결정" — 배포 즉시 관측이
 * 시작되고, 실제 이동은 env 를 auto 로 올려야 켜진다(이동 0 = 배포 순간 동작 불변).
 */
function routeMode() {
  const v = String(process.env.AUTO_FILE_ROUTE ?? 'dry').trim().toLowerCase();
  if (v === '0' || v === 'off') return 'off';
  if (v === '1' || v === 'auto' || v === 'on') return 'auto';
  return 'dry';
}

/** 중복 반려 스위치 — auto 모드에서만 의미 있음. AUTO_FILE_ROUTE_REJECT=0 이면 이동만 하고 반려는 끔. */
function rejectEnabled() { return process.env.AUTO_FILE_ROUTE_REJECT !== '0'; }

/**
 * 이동 판정(순수). 반환: {action:'none', reason} | {action:'route', toSlot, target}
 * @param {object} p
 * @param {string} p.slotKey          제출된 슬롯 key ('review'|'receipt'|...)
 * @param {object} p.verdict          captureVerify.verifyCapture 결과 ({status, got, sure})
 * @param {boolean} p.hasReceiptSlot  이 탭에 현금영수증 슬롯(폴더)이 있는가
 * @param {boolean} p.hasRouteSamples 구매캡처+구매확정 판별 예시가 **둘 다** 등록됐는가
 * @param {string}  p.expectedChannel 탭 기대 채널(카카오 제외 판정용)
 */
function routeDecision({ slotKey, verdict, hasReceiptSlot, hasRouteSamples, expectedChannel } = {}) {
  if (!verdict || verdict.status !== 'mismatch') return { action: 'none', reason: 'no_mismatch' };
  if (!verdict.sure) return { action: 'none', reason: 'not_sure' };
  if (EXEMPT_CHANNELS.includes(String(expectedChannel || ''))) return { action: 'none', reason: 'channel_exempt' };
  const t = ROUTE_TRANSITIONS[`${String(slotKey || '')}>${String(verdict.got || '')}`];
  if (!t) return { action: 'none', reason: 'no_transition' };
  if (t.needsReceiptSlot && !hasReceiptSlot) return { action: 'none', reason: 'no_receipt_slot' };
  if (t.needsRouteSamples && !hasRouteSamples) return { action: 'none', reason: 'no_route_samples' };
  return { action: 'route', toSlot: t.toSlot, target: t.target };
}

/** 사람이 읽는 슬롯 이름(안내문·알림용). 모르는 key 는 그대로. */
function routeSlotLabel(k) {
  return ({ review: '리뷰', receipt: '현금영수증', order_capture: '구매캡처' })[k] || String(k || '');
}

module.exports = { ROUTE_TRANSITIONS, EXEMPT_CHANNELS, routeMode, rejectEnabled, routeDecision, routeSlotLabel };
