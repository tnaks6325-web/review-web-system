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

/** 이 조각으로 읽어도 되는 공고 칸 — 늘릴 때는 그 값이 "탭 단위 설정"인지 먼저 따진다. */
const ALLOWED_COLUMNS = ['review_type', 'work_kind'];

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

module.exports = { campaignColLateral, ALLOWED_COLUMNS };
