'use strict';
/**
 * ★★ 결정 340 — 모집공고 신청 = 「이 신청이 나중에 들어갈 작업표 빈 줄이 있는가」 관문 (사용자 확정 A안 2026-11-06 · 스키마 변경 0)
 *
 * 사고(2026-08-28~09-02 · 키오스킨 마스크팩 1차 50건·클렌징폼 1차 100건): 직원이 외부모집 수동제출로 작업표 자리를 채웠는데
 *   모집공고는 공고 자체 신청 수만 세어 계속 신청을 받았다 → 리뷰어 6명이 실제 구매 뒤 구매양식을 내자 「작업표 빈 줄 없음」으로 빠졌다.
 *   (그 정확한 경로는 2026-09-08 부터 주문 원장 총량 관문 `CAMPAIGN_TABLE_QUOTA=on` 이 막는다 — 결정 031·193.
 *    이 관문은 그 관문이 못 보는 갈래 — 주문 기록 없이 이름·연락처로 찬 줄, 공유 작업표(주문 원장 관문 꺼짐), 지운·보류한 줄로
 *    정원보다 줄이 적어진 작업표 — 에서도 같은 일이 안 나게 하는 **작업표 기준 마지막 관문**이다.)
 *
 * 판정 = 빈 줄 수 − (아직 줄 없는 유효 신청 = 진행 중 홀드) − (줄을 기다리는 주문 = 끝나지 않은 workboard_apply) > 0 일 때만 받는다.
 *   - 빈 줄 = `utils/workboardNoSlot.openSlotCountSql`(실제 줄 고르기·결정 324 사전 확인과 같은 한 줄 판정 `openSlotRowSql`).
 *   - 진행 중 홀드 = 정원 셈과 같은 규칙 `status='applied' AND expires_at > NOW()`(fetchCampaignCounts) — 그 작업표에 연결된 **모든** 공고.
 *     ★ 신청하는 사람 본인의 같은 공고 홀드는 빼고 센다 — 이미 자리를 잡은 사람이 다시 누르면 종전처럼 「이미 참여 중」(duplicate_hold)
 *       으로 구매양식을 이어 열어야 한다(여기서 먼저 막으면 자기 자리에 막힌다).
 *   - 줄을 기다리는 주문 = `sync_queue` workboard_apply(끝나지 않음 · 그 작업표) 중 주문이 살아 있고 작업표 줄에 아직 안 붙은 것.
 *     빈 줄이 없어 보류된 주문(결정 324)도 센다 — 빈 줄이 생기면 그 주문이 먼저 그 줄을 가져간다.
 *
 * 적용 범위: 무시트 작업표(tab_configs.sheetless) + 활성 작업보드가 있는 작업만. 시트 작업·작업표 없는 공고·활성 작업보드 없음 = 종전(관문 없음).
 * ★ fail-open — 조회 실패·값 이상 = 종전대로 받는다(조회 실패로 모든 신청이 막히면 안 된다). 호출부는 SAVEPOINT 로 감싼다.
 * 끄는 스위치: `CAMPAIGN_WORKTABLE_ROOM_GATE=0`(조회 0 · 종전 동작).
 */
const { openSlotCountSql } = require('../utils/workboardNoSlot');

function enabled() {
  return String(process.env.CAMPAIGN_WORKTABLE_ROOM_GATE || '1') !== '0';
}

const ROOM_SQL = `
  SELECT ${openSlotCountSql('tc.sheet_id', 'tc.tab_name')}::int AS open_slots,
         (SELECT COUNT(*) FROM campaign_applications ca
            JOIN recruit_campaigns hrc ON hrc.id = ca.campaign_id
           WHERE hrc.linked_sheet_id = tc.sheet_id AND hrc.linked_tab_name = tc.tab_name
             AND ca.status = 'applied' AND ca.expires_at > NOW()
             AND NOT (ca.campaign_id = $3 AND ca.phone8 = $4))::int AS holds,
         (SELECT COUNT(DISTINCT os.id) FROM sync_queue q
            JOIN order_submissions os ON os.id::text = q.payload->>'orderSubmissionId'
           WHERE q.type = 'workboard_apply' AND q.status <> 'done'
             AND q.payload->>'sheetId' = tc.sheet_id AND q.payload->>'tabName' = tc.tab_name
             AND os.deleted_at IS NULL AND COALESCE(os.mirror_status, '') <> 'canceled'
             AND NOT EXISTS (SELECT 1 FROM campaign_participants wcp
                              WHERE wcp.order_submission_id = os.id AND wcp.deleted_at IS NULL))::int AS waiting_orders
    FROM tab_configs tc
    JOIN workboards w ON w.id = tc.workboard_id AND w.state = 'active'
   WHERE tc.sheet_id = $1 AND tc.tab_name = $2 AND COALESCE(tc.sheetless, FALSE) = TRUE
   LIMIT 1`;

/**
 * @returns {Promise<{applies:boolean, known:boolean, room:number|null, openSlots?:number, holds?:number, waitingOrders?:number}>}
 *   applies=false → 관문 대상 아님(종전) · known=false → 셀 수 없음(종전대로 받는다) · room ≤ 0 → 받을 자리 없음.
 */
async function worktableRoomForApply(db, { sheetId, tabName, campaignId, phone8 } = {}) {
  if (!enabled() || !db || typeof db.query !== 'function' || !sheetId || !tabName) return { applies: false, known: false, room: null };
  const { rows } = await db.query(ROOM_SQL, [sheetId, tabName, String(campaignId || ''), String(phone8 || '')]);
  const r = rows && rows[0];
  if (!r) return { applies: false, known: false, room: null };
  const openSlots = Number(r.open_slots), holds = Number(r.holds), waitingOrders = Number(r.waiting_orders);
  if (![openSlots, holds, waitingOrders].every(n => Number.isInteger(n) && n >= 0)) {
    return { applies: true, known: false, room: null };   // 모른다 = 종전(0 으로 꾸며 막지 않는다)
  }
  return { applies: true, known: true, openSlots, holds, waitingOrders, room: openSlots - holds - waitingOrders };
}

/** 받을 자리가 확실히 없을 때만 true — 대상 아님·모름은 false(fail-open). */
function isFull(v) {
  return !!(v && v.applies && v.known && Number.isFinite(v.room) && v.room <= 0);
}

module.exports = { worktableRoomForApply, isFull, enabled, ROOM_SQL };
