/**
 * purchaseTimeWindow — 작업오더의 구매시간대 문장("오후 2시~5시") → 모집공고 시간창(HH:MM)
 *
 * ★★ 이 규칙은 원래 **발행 화면에만** 있었다(`frontend/js/index-recruit.js` 의 `_parsePurchaseTime`)
 *    — 공고를 발행할 때 한 번 계산해 `window_start`/`window_end` 로 굳힌다.
 *    접수 뒤 인트라넷에서 구매시간대를 고치면 **서버가 이미 발행된 공고의 시간창도 고쳐야**
 *    리뷰어의 참여 가능 시간이 따라오므로 서버에도 같은 규칙이 필요해졌다.
 *
 * ★★★ **사본이 둘이 되는 자리다 — 회귀가드가 두 구현을 같은 문장 묶음으로 실행해
 *      결과가 한 글자도 다르지 않은지 대조한다**(`tests/inflowSourceEdit.test.js`).
 *      갈라지면 "발행할 땐 2시인데 고치면 3시" 가 된다.
 *
 * ★ **해석하지 못하면 null** — 지어내지 않는다. 호출부는 null 이면 **아무것도 바꾸지 않는다**
 *   (해석 못 하는 문장은 지금도 시간창 없이 하루 종일 열림으로 운영된다).
 * ★ 1~8 시는 오후로 읽는다(현장 표기 관행: "2시~5시" = 14:00~17:00).
 */

/** @returns {{start:string,end:string}|null} `HH:MM` 두 값, 해석 불가면 null */
function parsePurchaseTime(text) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*시?[^\d~\-]*[~\-][^\d]*(\d{1,2})(?::(\d{2}))?\s*시?/.exec(String(text || ''));
  if (!m) return null;
  let h1 = parseInt(m[1], 10);
  const m1 = parseInt(m[2] || '0', 10);
  let h2 = parseInt(m[3], 10);
  const m2 = parseInt(m[4] || '0', 10);
  if (h1 >= 1 && h1 <= 8) h1 += 12;
  if (h2 >= 1 && h2 <= 8) h2 += 12;
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59 || (h2 * 60 + m2) <= (h1 * 60 + m1)) return null;
  const pad = n => String(n).padStart(2, '0');
  return { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2 === 24 ? 24 : h2)}:${pad(m2)}` };
}

module.exports = { parsePurchaseTime };
