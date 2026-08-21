'use strict';
/**
 * 시트 행(row_json)에서 **결제금액** 을 읽는 규칙 — 단일 출처.
 *
 * ★★ 왜 여기 있나: 이 규칙을 쓰는 곳이 둘이다.
 *    ① 레거시 입금처리 `GET /api/payment/targets`(GAS 이관분) — 원래 이 함수가 살던 자리
 *    ② 입금관리 M1 `payment.service.listPaymentTargets` 의 **상품비**
 *    사본을 두면 "레거시 화면은 22,000원인데 입금관리는 0원"으로 갈린다.
 *
 * ★ 칸 선택은 **정확일치 우선 → 부분일치('금액' 포함)** 순서다. 순서를 뒤집으면
 *   `옵션금액`·`소계금액` 같은 칸이 `결제금액` 을 이긴다.
 *
 * ★★ 숫자 해석이 두 벌인 이유(2026-08-21 실사고) ─────────────────────────────
 *   `extractAmountNumber` 는 **숫자 아닌 문자를 전부 지우고 이어붙인다**. 그래서
 *   `"9,900원 0"` · `"9900.0"` 같은 칸이 조용히 **99,000** 이 된다(리뷰어 1명에게
 *   9,900+2,000=11,900 대신 **101,000 원**이 이체서식에 찍혔다 — 위드프렌즈 53번).
 *   돈이 나가는 경로는 **모호하면 멈춰야** 하므로 `parseAmountStrict` 를 따로 둔다:
 *     · 숫자 덩어리가 2개 이상        → 판정불가(`multi_number`)
 *     · 소수부에 0 아닌 자리가 있음   → 판정불가(`decimal`)
 *     · 콤마가 천단위 그룹이 아님     → 판정불가(`comma`)
 *   느슨한 쪽(`extractAmountNumber`)은 **레거시 표시 경로 호환**으로 남긴다 —
 *   칸을 고르는 규칙(`extractAmountEntry`)은 둘이 **같은 함수**를 쓴다(사본 0).
 */

/** 헤더 이름 정규화 — 공백만 제거(시트 헤더는 '결제 금액'처럼 띄어쓰기가 섞인다) */
const _norm = k => String(k == null ? '' : k).replace(/\s/g, '');
const _hasVal = v => v != null && String(v).trim() !== '';
const _obj = o => (o && typeof o === 'object') ? o : {};

/** 정확일치 후보(순서 = 우선순위) */
const EXACT_KEYS = ['결제금액', '결제금', '금액', '결제'];

/** 상품비를 어디서 읽었는지 — 화면이 근거를 말할 때 쓰는 값(문자열 사본 금지) */
const PRICE_SOURCE = { BOARD_EDIT: 'board_edit', BOARD: 'board', ORDER: 'order' };

/**
 * row_json(헤더명→값 맵)에서 결제금액 칸을 고른다 — **칸 선택 단일 출처**.
 * @param {object|null} rowJson
 * @returns {{key:string, text:string}} 못 찾으면 빈 값(추측하지 않는다)
 */
function extractAmountEntry(rowJson) {
  if (!rowJson || typeof rowJson !== 'object') return { key: '', text: '' };
  const entries = Object.entries(rowJson);
  for (const c of EXACT_KEYS) {
    const hit = entries.find(([k]) => _norm(k) === c);
    if (hit && _hasVal(hit[1])) return { key: hit[0], text: String(hit[1]).trim() };
  }
  // ★ 종전 동작 보존 — 부분일치는 **첫 '금액' 칸만** 보고, 그 칸이 비었으면 빈 값이다
  //   (여러 '금액' 칸을 훑으면 `옵션금액`·`소계금액` 이 조용히 결제금액 자리를 차지한다).
  const partial = entries.find(([k]) => _norm(k).includes('금액'));
  if (partial && _hasVal(partial[1])) return { key: partial[0], text: String(partial[1]).trim() };
  return { key: '', text: '' };
}

/**
 * row_json(헤더명→값 맵)에서 결제금액 **원문 문자열** 을 뽑는다.
 * 못 찾으면 빈 문자열(추측하지 않는다).
 * @param {object|null} rowJson
 * @returns {string}
 */
function extractAmountText(rowJson) {
  return extractAmountEntry(rowJson).text;
}

/**
 * 같은 규칙으로 뽑은 값을 **정수(원)** 로. 숫자를 못 읽으면 0.
 * ★ `22,000원`·`22000 원`처럼 통화 표기가 섞여 오므로 숫자만 남긴다.
 * ★ 음수 기호는 받지 않는다 — 시트에 `-` 만 적힌 칸(=미정 표기)이 마이너스 금액이 되면
 *   합계가 조용히 줄어든다(입금 사고). 숫자가 없으면 0.
 * ★★ 느슨한 판정이다 — **이체·입금처럼 돈이 나가는 경로는 `parseAmountStrict`** 를 쓴다.
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

/** 숫자 덩어리 하나 = 연속 숫자(천단위 콤마 포함) + 선택적 소수부 */
const _NUM_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * 금액 문자열 → 정수(원). **모호하면 값을 만들지 않는다.**
 * @param {*} raw
 * @returns {{ok:boolean, value:number, reason:string, raw:string}}
 *   reason: ok | empty | multi_number | decimal | comma | negative
 *   ★ `empty` 는 "그 칸에 값이 없다"는 뜻이라 호출부가 **다음 출처로 폴백**해도 되지만,
 *     나머지 사유는 "값은 있는데 못 읽겠다"라 폴백하면 안 된다(엉뚱한 금액이 나간다).
 */
function parseAmountStrict(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const out = (ok, value, reason) => ({ ok, value, reason, raw: s });
  if (!s) return out(false, 0, 'empty');
  const tokens = s.match(_NUM_TOKEN) || [];
  if (!tokens.length) return out(false, 0, 'empty');            // '-' 만 적힌 미정 표기 등
  if (tokens.length > 1) return out(false, 0, 'multi_number');  // "9,900원 0" → 99,000 사고
  // 음수 표기는 이체 금액이 될 수 없다 — 합계가 조용히 줄어드는 사고를 막는다.
  const at = s.indexOf(tokens[0]);
  if (at > 0 && /[-−▲△]\s*$/.test(s.slice(0, at))) return out(false, 0, 'negative');
  const tok = tokens[0].replace(/,+$/, '');
  const dot = tok.indexOf('.');
  const intPart = dot < 0 ? tok : tok.slice(0, dot);
  const decPart = dot < 0 ? '' : tok.slice(dot + 1);
  // `9900.0` 처럼 소수부가 0뿐이면 값이 변하지 않으므로 정수부를 쓴다(추측이 아니다).
  if (decPart && /[1-9]/.test(decPart)) return out(false, 0, 'decimal');
  if (intPart.indexOf(',') >= 0 && !/^\d{1,3}(,\d{3})+$/.test(intPart)) return out(false, 0, 'comma');
  const n = parseInt(intPart.replace(/,/g, ''), 10);
  if (!Number.isFinite(n) || n < 0) return out(false, 0, 'empty');
  return out(true, n, 'ok');
}

/**
 * row_json 에서 결제금액 칸을 고르고 **엄격 판정** 까지 한 결과.
 * @param {object|null} rowJson
 * @returns {{ok:boolean, value:number, reason:string, raw:string, key:string}}
 */
function extractAmountStrict(rowJson) {
  const entry = extractAmountEntry(rowJson);
  return { ...parseAmountStrict(entry.text), key: entry.key };
}

/**
 * 상품비를 **어느 값으로 이체할지** 정한다 — 우선순위 단일 출처.
 *
 * ★★ 사용자 확정(2026-08-21): **작업보드에 입력된 값이 기준**이다.
 *   ① 작업보드에서 사람이 고친 셀(`participant_edits` 오버레이)
 *   ② 작업보드 표에 보이는 값(`row_json` 결제금액 칸)
 *   ③ 주문원장(`order_submissions.price`) — 작업보드에 값이 없을 때의 **마지막 폴백**
 *
 *   종전에는 ③ 이 언제나 이겼다. 그래서 **화면은 9,900 인데 이체서식은 101,000**
 *   (원장 99,000 + 리뷰비 2,000) 이 나가도 사람이 알 길이 없었다 — 셀 편집은
 *   오버레이 전용이라 원장·row_json 을 절대 건드리지 않기 때문이다(trackB.editWorkdeskRow).
 *   "화면에 보이는 값 = 이체되는 값" 이어야 사람이 눈으로 검증할 수 있다.
 *
 * ★ ①②의 칸 선택은 **작업보드 그리드와 같은 방식**(row_json 위에 편집을 덮은 뒤 판정)이다.
 *   편집 맵만 따로 판정하면 `옵션금액` 편집이 `결제금액` 을 이기는 사고가 난다.
 * ★ 채택값과 원장값이 다르면 **막지 않고 경고**한다(`price_mismatch`) — 사람이 고친 값이
 *   기준이므로 차단하면 실무가 멈춘다. 대신 화면이 두 값을 나란히 보여준다(조용한 적용 금지).
 *
 * @param {object} p
 * @param {object|null} p.board            작업보드 장부값(row_json 중 금액 후보 칸)
 * @param {object|null} p.boardEdit        작업보드 셀 편집 오버레이({헤더:값})
 * @param {*}           p.ledgerText       주문원장 결제금액 원문
 * @param {boolean}     p.ledgerAmbiguous  그 행에 주문이 여러 건이라 원장을 특정 못함
 * @returns {{amount:number, source:string|null, reason:string, ledgerAmount:number,
 *           ledgerReadable:boolean, issues:string[], warnings:string[]}}
 */
function resolveProductPrice({ board = null, boardEdit = null, ledgerText = null, ledgerAmbiguous = false } = {}) {
  const issues = [], warnings = [];
  const edits = _obj(boardEdit);
  const merged = Object.assign({}, _obj(board), edits);   // = 작업보드 그리드가 그리는 값
  const entry = extractAmountEntry(merged);
  const ledger = parseAmountStrict(ledgerText);
  const ledgerAmount = ledger.ok ? ledger.value : 0;
  const done = (amount, source, reason) => ({
    amount, source, reason, ledgerAmount, ledgerReadable: ledger.ok, issues, warnings,
  });

  if (entry.key) {
    const parsed = parseAmountStrict(entry.text);
    const source = Object.prototype.hasOwnProperty.call(edits, entry.key)
      ? PRICE_SOURCE.BOARD_EDIT : PRICE_SOURCE.BOARD;
    if (!parsed.ok) { issues.push('price_unreadable'); return done(0, source, parsed.reason); }
    if (ledger.ok && ledgerAmount !== parsed.value) warnings.push('price_mismatch');
    if (ledgerAmbiguous) warnings.push('order_ambiguous');
    return done(parsed.value, source, 'ok');
  }

  // 작업보드에 값이 없다 — 사람이 **지운** 것과 애초에 칸이 빈 것을 구분한다.
  //   지운 값을 원장으로 되살리면 "화면엔 없는데 돈은 나간" 상태가 된다.
  if (Object.keys(edits).some(isAmountCandidateHeader)) {
    issues.push('price_unreadable');
    return done(0, PRICE_SOURCE.BOARD_EDIT, 'blanked');
  }

  if (ledgerAmbiguous) { issues.push('order_ambiguous'); return done(0, null, 'order_ambiguous'); }
  if (ledger.ok) return done(ledgerAmount, PRICE_SOURCE.ORDER, 'ok');
  if (ledger.reason !== 'empty') {
    issues.push('price_unreadable');
    return done(0, PRICE_SOURCE.ORDER, ledger.reason);
  }
  return done(0, null, 'empty');       // 어디에도 값이 없다 → 호출부가 `no_price` 로 막는다
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

module.exports = {
  extractAmountText, extractAmountNumber, extractAmountEntry,
  parseAmountStrict, extractAmountStrict, resolveProductPrice,
  isAmountCandidateHeader, EXACT_KEYS, PRICE_SOURCE,
};
