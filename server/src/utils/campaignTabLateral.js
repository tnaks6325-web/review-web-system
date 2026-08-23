// ═══════════════════════════════════════════════════════════════════════════
// "그 탭에 연결된 공고에서 한 칸 읽기" SQL 조각 — 단일 출처
//
// 소비처: reviewTypeContext(리뷰타입) · workKindContext(체험단 종류).
// ★★ 사본을 두면 조용히 갈라진다 — 실제로 리뷰타입 쪽에서 두 번 밟은 규칙이 여기 들어 있다:
//   ㉮ **gid 폴백** — `linked_tab_name` 이름 매칭만 하면 탭을 리네임하는 순간 공고를 못 찾아
//      설정이 조용히 풀린다(★ 빈 gid 는 키를 만들지 않는다 — 만들면 gid 없는 탭이 전부 매칭된다).
//   ㉯ **값이 있는 최신 공고** — 차수 재발행으로 한 탭에 공고가 여럿일 때 `ORDER BY created_at DESC`
//      만 쓰면 **최신 공고의 빈 값**이 옛 공고의 설정을 가린다. '미지정'은 관리자가 정하지 않은
//      것이라 가리지 않는다(최신이 명시돼 있으면 최신이 그대로 이긴다).
//
// ★ 조각은 `tab_configs c` 를 바깥 테이블로 전제한다(c.sheet_id · c.tab_name · c.tab_gid).
// ★ 컬럼명은 SQL 에 그대로 박히므로 **허용목록으로만** 받는다(자유 문자열 금지).
// ═══════════════════════════════════════════════════════════════════════════

/** 이 조각으로 읽어도 되는 공고 칸 — 늘릴 때는 그 값이 "탭 단위 설정"인지 먼저 따진다.
 *  ★ `title` = 리뷰어 카드에 보이는 **작업 이름**(2026-08-19 사용자 확정: 접수 시점 탭 이름이
 *    아니라 지금 적용된 공고 제목으로 표기). 같은 조각을 쓰므로 리네임(gid 폴백)·차수 재발행
 *    (값이 있는 최신 공고) 규칙을 그대로 물려받는다. */
const ALLOWED_COLUMNS = ['review_type', 'work_kind', 'title'];

/**
 * @param {string} col    recruit_campaigns 의 칸 이름(ALLOWED_COLUMNS 안)
 * @param {string} alias  LATERAL 별칭(바깥 SELECT 에서 `<alias>.<col>` 로 읽는다)
 * @returns {string} LEFT JOIN LATERAL 조각
 */
function campaignColLateral(col, alias) {
  if (!ALLOWED_COLUMNS.includes(col)) throw new Error(`campaignColLateral: 허용되지 않은 칸 ${col}`);
  if (!/^[a-z][a-z0-9_]*$/.test(String(alias || ''))) throw new Error('campaignColLateral: 잘못된 별칭');
  return `
       LEFT JOIN LATERAL (
            SELECT ${col}
              FROM recruit_campaigns
             WHERE linked_sheet_id = c.sheet_id
               AND (linked_tab_name = c.tab_name
                    OR (COALESCE(c.tab_gid, '') <> '' AND linked_tab_gid = c.tab_gid))
               AND COALESCE(${col}, '') <> ''
             ORDER BY created_at DESC
             LIMIT 1
       ) ${alias} ON TRUE`;
}

/**
 * ★★ 탭 리네임 시 **공고의 연결 탭 이름도 따라가게** 한다 (2026-08-24 실측 사고).
 *
 * 무엇이 문제였나: 탭 이름이 바뀌면 `review_index`·`index_master`·`tab_configs` 는 자가치유로
 * 따라가는데 **`recruit_campaigns.linked_tab_name` 만 옛 이름에 멈춰 있었다**. 그러면 공고↔작업표
 * 연결을 **이름으로** 찾는 경로가 통째로 죽는다 — [📅 인원]이 빈 채로 열리고 정원 판정·날짜 정렬이
 * 조용히 멈춘다(실측: 「맛고」 탭, 공고는 옛 양식 이름 `체험단시트양식1` 을 가리키고 있었다).
 *
 * ★★ **여기서 이름을 맞춰야 하는 이유** — 판정 함수(`isSheetless`)에만 gid 폴백을 넣으면 "연결됨"
 *   으로 바뀌지만 **뒤따르는 조회가 전부 `tab_name` 으로 작업표를 찾아** 0줄이 나온다. 연결됐다는데
 *   화면이 텅 빈, 더 나쁜 상태가 된다. 이름 자체를 맞추면 그 조회들이 전부 자동으로 정상화된다.
 *
 * ★ 조건에 맞는 공고는 **전부** 고친다(차수 재발행으로 한 탭에 공고가 여럿일 수 있다).
 * ★ 보관된 공고도 고친다 — 보관을 풀었을 때 정상이어야 한다.
 * ★ **빈 gid 는 덮지 않는다**(모르는 값으로 기존 값을 지우지 않는다).
 * ★ **절대 throw 하지 않는다** — 이 보정이 실패해도 탭 이름 자가치유는 계속돼야 한다.
 *
 * @param {object} db  pool 또는 트랜잭션 client
 * @returns {Promise<number>} 고친 공고 수(실패 시 0)
 */
async function renameCampaignLinkedTab(db, { sheetId, oldTabName, newTabName, tabGid } = {}) {
  if (!db || !sheetId || !oldTabName || !newTabName || oldTabName === newTabName) return 0;
  try {
    const { rowCount } = await db.query(
      `UPDATE recruit_campaigns
          SET linked_tab_name = $1,
              linked_tab_gid  = COALESCE(NULLIF($2, ''), linked_tab_gid)
        WHERE linked_sheet_id = $3 AND linked_tab_name = $4`,
      [newTabName, String(tabGid == null ? '' : tabGid), sheetId, oldTabName]);
    return rowCount || 0;
  } catch (e) {
    try {
      require('./logger').logger.warn(
        `[campaignTabLateral] 공고 연결 탭 이름 보정 실패 (건너뜀) ${oldTabName} -> ${newTabName}: ${(e && e.message) || e}`);
    } catch (_) { /* 로깅 실패도 삼킨다 — 보정은 부수 작업이다 */ }
    return 0;
  }
}

module.exports = { campaignColLateral, ALLOWED_COLUMNS, renameCampaignLinkedTab };
