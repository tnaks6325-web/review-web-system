/**
 * 캡처 파일명에 쓸 "그 건의 수취인" 해석 — 단일 출처.
 *
 * ★★ 왜 서버가 정하는가: 파일명 이름을 프론트가 골라 보내면 창구마다 기준이 갈린다.
 *   실제로 리뷰어 제출 2경로는 `수취인 → 주문자` 폴백인데 작업보드 [📎 리뷰 대신 제출]은
 *   참여자(로그인 본계정) 이름만 보내, 같은 작업의 캡처가 창구에 따라 다른 이름으로 쌓였다.
 *   여기 한 곳에서 정하면 어느 창구로 올리든 같은 이름이 된다(화면이 보낸 값은 폴백).
 *
 * ★★ 왜 수취인인가(사용자 확정 2026-09-22): 타계정 참여는 주문자가 로그인 본계정 한 사람이라
 *   파일명이 전부 같은 이름이 되어 **어떤 타계정의 리뷰인지 구분할 수 없다**. 수취인은 건마다
 *   달라 그 자리에서 구분된다. 리뷰어 화면의 "참여 명의 = 수취인"(결정 009, 2026-09-21 확정)과
 *   **같은 방향** — 화면에 보이는 이름과 Drive 에 쌓이는 이름이 갈리지 않는다.
 *
 * ★ 프론트 `_partInfoParticipantName`(index.html) 과는 **층이 다르다** — 그쪽은 이미 받은 응답
 *   객체에서 고르는 화면 표시용이고, 여기는 응답에 없는 값까지 DB 에서 찾는 저장용이다(사본 아님).
 *
 * 해석 순서(그 행의 수취인을 아는 곳 전부 — 위에서부터):
 *   ① `review_index.recipient_name`      — 검색 명단(시트 기반 탭은 빌더가 채운다)
 *   ② `campaign_participants.recipient_name` — 무시트 작업표(주문 기록이 채운다)
 *   ③ `order_submissions.recipient`      — 주문 원장(작업표 줄에 연결된 주문)
 *
 * ★ 왕복 1회(LEFT JOIN 한 문장) · **읽기 전용** · 못 찾으면 null(호출부가 종전 값으로 폴백).
 * ★ fail-soft — 조회가 실패해도 **업로드를 막지 않는다**(이름은 편의, 제출이 본질).
 */

const { logger } = require('../utils/logger');

/**
 * @param {{ db:object, sheetId:string, tabName:string, rowIndex:number|string }} p
 * @returns {Promise<string|null>} 수취인 이름(공백 제거 후 빈 값이면 null)
 */
async function recipientNameForRow({ db, sheetId, tabName, rowIndex } = {}) {
  const sid = String(sheetId || '').trim();
  const tab = String(tabName || '').trim();
  /* ★★ `Number(null)`·`Number('')` 은 **0** 이다 — 가드 없이 받으면 "줄 번호 없음"이 0행 조회로
     둔갑해 쓸데없는 왕복을 돌고, 0행이 존재하는 표에서는 엉뚱한 줄의 이름을 집는다.
     시트 실제 행 번호는 1 이상이므로 빈 값·0 이하는 여기서 끊는다(082 `_int` 규율). */
  const rawRow = (rowIndex === null || rowIndex === undefined) ? '' : String(rowIndex).trim();
  const row = rawRow === '' ? NaN : Number(rawRow);
  // 좌표가 없으면 그 행을 특정할 수 없다 — 추측하지 않는다.
  if (!db || !sid || !tab || !Number.isInteger(row) || row <= 0) return null;

  try {
    const { rows } = await db.query(
      `SELECT COALESCE(
                NULLIF(BTRIM(ri.recipient_name), ''),
                NULLIF(BTRIM(cp.recipient_name), ''),
                NULLIF(BTRIM(os.recipient), '')
              ) AS name
         FROM (SELECT $1::text AS sheet_id, $2::text AS tab_name, $3::int AS row_index) k
         LEFT JOIN review_index ri
                ON ri.sheet_id = k.sheet_id AND ri.tab_name = k.tab_name
               AND ri.row_index = k.row_index
         LEFT JOIN campaign_participants cp
                ON cp.sheet_id = k.sheet_id AND cp.tab_name = k.tab_name
               AND cp.seq = k.row_index AND cp.deleted_at IS NULL AND cp.active = TRUE
         LEFT JOIN order_submissions os
                ON os.id = cp.order_submission_id AND os.deleted_at IS NULL
        LIMIT 1`,
      [sid, tab, row]
    );
    const name = rows && rows[0] ? String(rows[0].name || '').trim() : '';
    return name || null;
  } catch (e) {
    // 모르면 종전 이름으로 떨어진다 — 파일명 때문에 제출이 실패하면 안 된다.
    logger.warn(`[captureOwnerName] 수취인 조회 실패(종전 이름 사용): ${e.message}`);
    return null;
  }
}

module.exports = { recipientNameForRow };
