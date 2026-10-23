/**
 * 결정 273 — 모집공고 실제 시작일 = 첫 참여일 (사용자 확정 2026-10-23 「나 · 1.가 · 2.가」)
 *
 * 리뷰오더의 시작일은 "희망 시작일"이다. 공고의 실제 시작일은 리뷰웹에서 사람이 정하거나(start_date_basis='manual'),
 * 아무도 정하지 않았으면(start_date_basis='pending') 첫 참여가 생긴 날로 **한 번** 맞춘다('first_join').
 *
 * 첫 참여 = 정원이 "참여"로 세는 것과 같은 것 중 가장 이른 시각(KST 날짜):
 *   ① 구매 확정된 신청(campaign_applications.status='submitted' · submitted_at)
 *   ② 블로그 승인(decided_at — 승인 = 'applied' 전이, 127)
 *   ③ 공고 밖 주문 — 공고 좌표 ∪ 연결 탭 좌표(시작일 이후) · 취소 규칙은 ORDER_COUNTED_SQL 단일 출처
 *   ★ 탭 좌표 주문은 지금 시작일 이후 것만 본다 = 지금 세고 있는 주문 중 가장 이른 날 → 시작일을 그날로 옮겨도
 *     집계에서 빠지는 주문이 없다(시작일 앞 주문을 자르는 앵커 — campaignState._loadLinkedOrderCounts).
 *
 * ★★ 앞으로만 옮긴다(첫 참여일 ≥ 지금 시작일, 또는 시작일 없음) — 뒤로 당기면 시작일 전이라 닫혀 있던 공고가
 *    희망 시작일보다 먼저 열린다(수동으로 넣은 이른 주문 하나가 공고를 미리 여는 사고). 그런 공고는 그대로 둔다.
 * ★★ 'pending' 만 — 이 칸 이전 공고(NULL)는 손대지 않는다(사용자 확정 1.가). 사람이 정한 날('manual')은 절대 안 바꾼다.
 *    같은 문장 안에서 다시 확인한다(UPDATE … WHERE start_date_basis='pending') — 그 사이 사람이 저장하면 사람이 이긴다.
 * ★ 시작일이 바뀌면 정원 규칙 트리거(175~179)가 quota_rules_changed_at 을 찍는다(어제 부족 인원 팝업을 그날 쉬게 한다 — 규칙이 바뀌었으니 맞다).
 * ★ 새벽 4시 10분(작업표 날짜 맞추기 4시 20분보다 먼저 — 그쪽이 새 시작일로 빈 줄 날짜를 맞춘다).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { ORDER_COUNTED_SQL } = require('./campaignState.service');

const FIRST_JOIN_SQL = `
  SELECT rc.id, rc.start_date, (LEAST(
           (SELECT MIN(ca.submitted_at) FROM campaign_applications ca
             WHERE ca.campaign_id = rc.id AND ca.status = 'submitted'),
           (SELECT MIN(ca.decided_at) FROM campaign_applications ca
             WHERE ca.campaign_id = rc.id AND ca.status IN ('applied', 'submitted') AND ca.decided_at IS NOT NULL),
           (SELECT MIN(os.submitted_at) FROM order_submissions os
             WHERE ${ORDER_COUNTED_SQL}
               AND (
                    (os.sheet_id = 'campaign:' || rc.id AND os.tab_name = 'campaign:' || rc.id)
                 OR (os.sheet_id = rc.linked_sheet_id
                     AND (os.tab_name = rc.linked_tab_name
                          OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL
                              AND NULLIF(os.tab_gid,'') = NULLIF(rc.linked_tab_gid,'')))
                     AND os.submitted_at >= COALESCE((rc.start_date::text || 'T00:00:00+09:00')::timestamptz, rc.created_at))
               ))
         ) AT TIME ZONE 'Asia/Seoul')::date AS first_day
    FROM recruit_campaigns rc
   WHERE rc.start_date_basis = 'pending' AND rc.archived_at IS NULL`;

/**
 * @returns {{ checked:number, corrected:Array<{id,from,to}>, skippedEarlier:Array<{id,start,first}> }}
 *   dryRun=true 면 바꾸지 않고 바꿀 목록만 돌려준다.
 */
async function correctStartDatesToFirstJoin({ db = pool, dryRun = false } = {}) {
  const { rows } = await db.query(FIRST_JOIN_SQL);
  const iso = d => (d ? (d instanceof Date ? _ymd(d) : String(d).slice(0, 10)) : null);
  const corrected = [], skippedEarlier = [];
  for (const r of rows) {
    const first = iso(r.first_day), start = iso(r.start_date);
    if (!first) continue;                                         // 아직 참여 없음 — 내일 다시 본다
    if (start && first < start) { skippedEarlier.push({ id: r.id, start, first }); continue; }   // 앞으로만
    if (dryRun) { corrected.push({ id: r.id, from: start, to: first }); continue; }
    const { rowCount } = await db.query(
      `UPDATE recruit_campaigns
          SET start_date = $2::date, start_date_basis = 'first_join', updated_at = NOW()
        WHERE id = $1 AND start_date_basis = 'pending'
          AND (start_date IS NULL OR start_date <= $2::date)`,
      [r.id, first]);
    if (rowCount) {
      corrected.push({ id: r.id, from: start, to: first });
      logger.info(`[campaignStartDate] ${r.id} 시작일 ${start || '(없음)'} → ${first} (첫 참여일)`);
    }
  }
  return { checked: rows.length, corrected, skippedEarlier };
}

// pg DATE 는 서버 시간대의 자정 Date 로 온다 — 그 시간대의 연·월·일을 그대로 읽는다(ISO 로 자르면 KST 서버에서 하루 당겨진다)
function _ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { correctStartDatesToFirstJoin, FIRST_JOIN_SQL };
