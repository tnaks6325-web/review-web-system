/**
 * tableOrderNum.js — "작업보드 표에 실제로 보이는 주문번호" 단일 출처.
 *
 * ★★ 왜 공유 조각인가 (2026-08-19 실사고 두 건이 같은 값을 봐야 한다):
 *   ① 중복 줄 정리(`sheetlessLedger.dedupeRows`) — 표 주문번호가 다르면 묶지 않는다.
 *   ② 무시트 주문 기록(`sheetlessOrder.writeOrderToWorktable`) — 같은 구매가 이미 표에 있으면
 *      새 빈 슬롯을 먹지 않는다.
 *   둘이 서로 다른 규칙으로 "표 주문번호"를 뽑으면 한쪽은 중복으로 지우고 다른 쪽은 중복이
 *   아니라며 또 만드는 상태가 된다(실제로 그래서 10분 크론이 같은 주문을 11줄로 늘렸다).
 *
 * ★ 규칙: `row_json` 의 키 이름에 `주문번호` 가 들어간 칸을 **키 순서대로 이어 붙여** 숫자만 남긴다.
 *   탭마다 헤더가 다르고(`주문번호`·`쿠팡주문번호`…) 한 탭에 둘 이상일 수 있어 하나만 고르지 않는다.
 * ★ 담당자가 화면에서 눈으로 보는 값이 곧 판정 값이다 — 원장(`order_submissions.order_num`)만
 *   보면 "화면에는 서로 다른 주문번호인데 중복으로 잡히는" 일이 생긴다.
 */

/**
 * @param {string} alias  campaign_participants 의 별칭(예: 'cp')
 * @returns {string} 숫자만 남긴 표 주문번호를 내는 SQL 식
 */
function tableOrderNumSql(alias = 'cp') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(alias))) throw new Error('tableOrderNumSql: 잘못된 별칭');
  return `regexp_replace(COALESCE((
              SELECT string_agg(t.value, '' ORDER BY t.key)
                FROM jsonb_each_text(COALESCE(${alias}.row_json, '{}'::jsonb)) t(key, value)
               WHERE t.key LIKE '%주문번호%'
            ), ''), '\\D', '', 'g')`;
}

/** 표 주문번호로 "같은 구매"를 판정할 수 있는 최소 자릿수. 미만이면 판정하지 않는다(모르면 막지 않는다). */
const MIN_ORDER_NUM_DIGITS = 6;

module.exports = { tableOrderNumSql, MIN_ORDER_NUM_DIGITS };
