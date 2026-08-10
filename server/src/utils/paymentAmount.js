'use strict';
/**
 * 시트 행(row_json)에서 **결제금액** 을 읽는 규칙 — 단일 출처.
 *
 * ★★ 왜 여기 있나: 이 규칙을 쓰는 곳이 둘이다.
 *    ① 레거시 입금처리 `GET /api/payment/targets`(GAS 이관분) — 원래 이 함수가 살던 자리
 *    ② 입금관리 M1 `payment.service.listPaymentTargets` 의 **상품비 폴백**
 *      (주문 원장에 그 행의 결제금액이 없을 때 = 옛 작업·직원 수기 입력 행)
 *    사본을 두면 "레거시 화면은 22,000원인데 입금관리는 0원"으로 갈린다.
 *
 * ★ 판정은 **정확일치 우선 → 부분일치('금액' 포함)** 순서다. 순서를 뒤집으면
 *   `옵션금액`·`소계금액` 같은 칸이 `결제금액` 을 이긴다.
 */

/** 헤더 이름 정규화 — 공백만 제거(시트 헤더는 '결제 금액'처럼 띄어쓰기가 섞인다) */
const _norm = k => String(k == null ? '' : k).replace(/\s/g, '');
const _hasVal = v => v != null && String(v).trim() !== '';

/** 정확일치 후보(순서 = 우선순위) */
const EXACT_KEYS = ['결제금액', '결제금', '금액', '결제'];

/**
 * row_json(헤더명→값 맵)에서 결제금액 **원문 문자열** 을 뽑는다.
 * 못 찾으면 빈 문자열(추측하지 않는다).
 * @param {object|null} rowJson
 * @returns {string}
 */
function extractAmountText(rowJson) {
  if (!rowJson || typeof rowJson !== 'object') return '';
  const entries = Object.entries(rowJson);
  for (const c of EXACT_KEYS) {
    const hit = entries.find(([k]) => _norm(k) === c);
    if (hit && _hasVal(hit[1])) return String(hit[1]).trim();
  }
  const partial = entries.find(([k]) => _norm(k).includes('금액'));
  if (partial && _hasVal(partial[1])) return String(partial[1]).trim();
  return '';
}

/**
 * 같은 규칙으로 뽑은 값을 **정수(원)** 로. 숫자를 못 읽으면 0.
 * ★ `22,000원`·`22000 원`처럼 통화 표기가 섞여 오므로 숫자만 남긴다.
 * ★ 음수 기호는 받지 않는다 — 시트에 `-` 만 적힌 칸(=미정 표기)이 마이너스 금액이 되면
 *   합계가 조용히 줄어든다(입금 사고). 숫자가 없으면 0.
 * @param {object|null} rowJson
 * @returns {number}
 */
function extractAmountNumber(rowJson) {
  const raw = extractAmountText(rowJson);
  if (!raw) return 0;
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return 0;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 위 판정이 **볼 수도 있는** 헤더인가(상위집합 필터).
 * ★ 서버가 `row_json` 을 통째로 끌어오지 않기 위해 SQL 에서 후보 칸만 남길 때 쓴다 —
 *   여기서 넓게 거르고 **최종 판정은 위 함수가** 한다(SQL 에 판정 사본 금지).
 * @param {string} key
 */
function isAmountCandidateHeader(key) {
  const k = _norm(key);
  if (!k) return false;
  return k.includes('금액') || EXACT_KEYS.includes(k);
}

module.exports = { extractAmountText, extractAmountNumber, isAmountCandidateHeader, EXACT_KEYS };
