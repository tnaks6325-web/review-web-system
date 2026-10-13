'use strict';

/**
 * 바로 구매를 공고 참여 규칙에 세기 (결정 238, 사용자 확정 2026-10-13 "구매양식 링크로 바로 제출한것도 참여로 간주").
 *
 * 바로 구매 = 공고 「참여하기」(campaign_applications) 없이 구매양식 링크·관리자 수동제출로 바로 낸 주문.
 *   order_submissions 중 campaign_application_id IS NULL · deleted_at IS NULL 이고,
 *   그 작업표(sheet_id, tab_name)가 참여형 공고(participation_mode)에 연결된 주문만 센다.
 *   공고와 무관한 작업표 주문(순수 외부모집)은 공고 참여가 아니다.
 *
 * ★ 바로 구매에는 리뷰어 계정 연결(owner_reviewer_id·participant_identity_id)이 없다 — 명의는 주문서 연락처 끝 8자리다.
 *   명의 자체를 기준으로 세는 규칙(하루 상한·인기 참여권)은 그 번호 그대로 세고,
 *   "같은 사람의 다른 명의"가 필요한 규칙(타계정 하루 한도)은 repurchaseGuard 와 같은 신뢰 모델 —
 *   본계정 번호 + 발급된 코드 신원(reviewer_identities active)만 쓴다. 편집 가능한 sub_accounts 는 믿지 않는다.
 * ★ 연결 안 된 번호의 구매는 세지 않는다(모르는 구매로 사람을 막지 않는다). 호출부는 조회 실패를 fail-open 으로 접는다.
 */

// ★ OS_PHONE8 은 migration 168 표현식 인덱스 idx_os_phone8_all 과 글자 그대로 같아야 한다 — 그래야 참여 잠금 안의
//   명의별 조회가 원장 전체 스캔 대신 인덱스를 탄다(운영 EXPLAIN 2026-10-13: Bitmap Index Scan on idx_os_phone8_all).
const OS_PHONE8 = `RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8)`;
const DIRECT_PURCHASE_WHERE = `os.campaign_application_id IS NULL AND os.deleted_at IS NULL`;

function _phone8(value) {
  return String(value || '').replace(/\D/g, '').slice(-8);
}

/** 본계정 번호 + 발급된 코드 신원 번호(소유 증명된 명의만). */
async function loadVerifiedOwnerPhones(q, { ownerPhone8, ownerReviewerId } = {}) {
  const owner = _phone8(ownerPhone8);
  const phones = new Set(owner.length === 8 ? [owner] : []);
  const ownerId = /^[0-9a-f-]{36}$/i.test(String(ownerReviewerId || '')) ? String(ownerReviewerId) : null;
  if (ownerId) {
    const { rows } = await q.query(
      `SELECT current_phone8 FROM reviewer_identities
        WHERE owner_reviewer_id = $1::uuid AND status = 'active'`, [ownerId]);
    for (const r of rows) {
      const p8 = _phone8(r.current_phone8);
      if (p8.length === 8) phones.add(p8);
    }
  }
  return [...phones];
}

/** 이 명의(phone8)가 sinceIso 이후 낸 바로 구매 수 — 명의별 하루 참여 상한용. */
async function countDirectPurchasesSince(q, { phone8, sinceIso }) {
  const p8 = _phone8(phone8);
  if (p8.length !== 8 || !sinceIso) return 0;
  const { rows } = await q.query(
    `SELECT COUNT(*) AS n
       FROM order_submissions os
      WHERE ${DIRECT_PURCHASE_WHERE}
        AND os.submitted_at >= $2
        AND ${OS_PHONE8} = $1
        AND EXISTS (
          SELECT 1 FROM recruit_campaigns rc
           WHERE rc.participation_mode IS TRUE
             AND rc.linked_sheet_id = os.sheet_id AND rc.linked_tab_name = os.tab_name
        )`, [p8, sinceIso]);
  return Number(rows[0] && rows[0].n) || 0;
}

/**
 * 이 공고 작업표에서 소유자의 다른 명의(본계정 제외, 소유 증명된 명의만)가 sinceIso 이후 낸 바로 구매 수
 * — 공고별 타계정 하루 한도용(countCampaignSubDailyUsage 와 합산).
 */
async function countCampaignSubDirectPurchasesSince(q, { campaignId, ownerPhone8, ownerReviewerId, sinceIso }) {
  const owner = _phone8(ownerPhone8);
  if (!campaignId || !sinceIso) return 0;
  const subs = (await loadVerifiedOwnerPhones(q, { ownerPhone8: owner, ownerReviewerId }))
    .filter(p8 => p8 !== owner);
  if (!subs.length) return 0;
  const { rows } = await q.query(
    `SELECT COUNT(*) AS n
       FROM recruit_campaigns rc
       JOIN order_submissions os
         ON os.sheet_id = rc.linked_sheet_id AND os.tab_name = rc.linked_tab_name
      WHERE rc.id = $1
        AND ${DIRECT_PURCHASE_WHERE}
        AND os.submitted_at >= $2
        AND ${OS_PHONE8} = ANY($3::text[])`, [campaignId, sinceIso, subs]);
  return Number(rows[0] && rows[0].n) || 0;
}

/**
 * 인기 참여권 계산용 바로 구매 이벤트 — popularCredit.service 의 이벤트 행과 같은 모양.
 * 일반 공고 작업표의 바로 구매 = 일반 참여(참여권 적립), 인기 공고 작업표의 바로 구매 = 인기 참여(참여권 소비).
 * id 는 공고 참여 id 와 겹치지 않게 'os:' 를 붙인다.
 */
async function loadDirectPurchaseCreditEvents(q, { phones = null, from, to }) {
  const scoped = Array.isArray(phones)
    ? [...new Set(phones.map(_phone8).filter(p8 => p8.length === 8))]
    : null;
  if (scoped && !scoped.length) return [];
  const phoneClause = scoped ? `AND ${OS_PHONE8} = ANY($3::text[])` : '';
  const params = scoped ? [from, to, scoped] : [from, to];
  const { rows } = await q.query(
    `SELECT 'os:' || os.id AS id, ${OS_PHONE8} AS phone8, 'submitted' AS status,
            CASE WHEN camp.is_popular IS TRUE THEN 'popular' ELSE 'normal' END AS event_type,
            os.submitted_at AS event_at
       FROM order_submissions os
       JOIN LATERAL (
         SELECT rc.is_popular
           FROM recruit_campaigns rc
          WHERE rc.participation_mode IS TRUE
            AND rc.linked_sheet_id = os.sheet_id AND rc.linked_tab_name = os.tab_name
          -- 같은 작업표에 공고가 여러 개(차수 재발행)면 구매 시점에 이미 있던 가장 최근 공고로 본다 —
          -- 나중에 만든 공고의 인기 여부가 지난 구매에 소급되지 않게(Codex PR #1623).
          ORDER BY (rc.created_at <= os.submitted_at) DESC NULLS LAST, rc.created_at DESC NULLS LAST, rc.id DESC
          LIMIT 1
       ) camp ON TRUE
      WHERE ${DIRECT_PURCHASE_WHERE}
        AND os.submitted_at BETWEEN $1 AND $2
        -- 연락처가 8자리 번호가 아닌 주문은 명의를 알 수 없다 — 그런 주문끼리 참여권을 주고받지 않게 뺀다(Codex PR #1627).
        AND ${OS_PHONE8} ~ '^[0-9]{8}$'
        ${phoneClause}`, params);
  return rows;
}

module.exports = {
  loadVerifiedOwnerPhones,
  countDirectPurchasesSince,
  countCampaignSubDirectPurchasesSince,
  loadDirectPurchaseCreditEvents,
};
