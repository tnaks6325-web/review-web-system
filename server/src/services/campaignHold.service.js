/**
 * campaignHold.service.js — 참여형 캠페인 홀드 확정·만료 스윕·closed 영속 (레드-블루-심판 최종안)
 *
 * 잠금 계층(고정): recruit_campaigns 행(FOR UPDATE) → campaign_applications 행.
 *   apply(campaign.routes)·주문확정(confirmHoldInTx)·수동확정(admin confirm) 모두 이 순서만 사용 → 교착 불가.
 *   스윕은 FOR UPDATE SKIP LOCKED — 확정 tx가 잡은 행은 건너뛴다(다음 분 재시도; 어차피 확정/취소 중).
 * ※ order_submissions.id = UUID (campaign_applications.order_submission_id/late_order_id도 UUID — 045, 심판 J1).
 */
const { logger } = require('../utils/logger');

// 처리지연 grace(사용자 유예 아님 — 유예 정책은 제거됨): 확정 UPDATE와 스윕이 같은 경계를 공유해
// "TTL 마지막 초 제출이 처리지연으로 expired" 경합 창을 제거한다.
// NaN 가드(코드리뷰 #6): env 비숫자면 make_interval(NaN)으로 확정·스윕 SQL이 전부 실패하므로 30 폴백.
const _grace = parseInt(process.env.CAMPAIGN_HOLD_GRACE_SEC || '30', 10);
const HOLD_GRACE_SEC = Number.isFinite(_grace) && _grace >= 0 ? _grace : 30;

/** gid 우선(탭 리네임 불변) → gid 없으면 정규화 이름 비교 (레드 #6) */
function tabMatchesCampaign(camp, sheetId, gid, tabName) {
  if (!camp || !camp.linked_sheet_id || String(camp.linked_sheet_id) !== String(sheetId || '')) return false;
  if (camp.linked_tab_gid && gid) return String(camp.linked_tab_gid) === String(gid);
  const norm = (s) => String(s || '').trim().normalize('NFC');
  return !!camp.linked_tab_name && norm(camp.linked_tab_name) === norm(tabName);
}

/** closed 영속 단일 헬퍼 — 자동확정·수동확정·스윕 백스톱 공용. 멱등(WHERE status='active'). */
async function maybePersistClosed(q, campaignId) {
  await q.query(
    `UPDATE recruit_campaigns rc SET status = 'closed', updated_at = NOW()
      WHERE rc.id = $1 AND rc.participation_mode AND rc.status = 'active' AND rc.recruit_total > 0
        AND (SELECT COUNT(*) FROM campaign_applications ca
              WHERE ca.campaign_id = rc.id AND ca.status = 'submitted') >= rc.recruit_total`,
    [campaignId]
  );
}

/**
 * 주문 트랜잭션 안에서 홀드 확정. 반드시 orderLedger의 client 트랜잭션 내부에서 호출.
 * 반환: 'confirmed' | 'late' | 'tab_mismatch' | 'not_found' | 'invalid_params'
 *   — 어떤 반환값이든 주문 저장은 막지 않는다(호출측이 SAVEPOINT로 예외도 격리).
 */
async function confirmHoldInTx(client, { applicationId, campaignId, phone8, holdToken, orderSubmissionId, sheetId, gid, tabName }) {
  const appId = parseInt(applicationId, 10);
  if (!appId || !campaignId || !holdToken || !phone8) return 'invalid_params';

  // 잠금 계층 1: 캠페인 행 — apply·수동확정과 동일 순서(교착 불가)
  const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
  if (!cRows.length || !cRows[0].participation_mode) return 'not_found';
  const camp = cRows[0];

  // provenance 링크: 확정 성패와 무관하게 기록 → 만료건은 스윕이 late_order_id 백필(관제 수동확정 목록 입력).
  //   ★ 소유권 검증을 통과한 신청에만 링크(코드리뷰 #1): applicationId는 클라이언트 입력(SERIAL 추측 가능)이라
  //     무검증 링크는 타인 신청 오염 → 스윕 백필 → 수동확정 오염으로 전파된다.
  await client.query(
    `UPDATE order_submissions os SET campaign_application_id = $2
      WHERE os.id = $1 AND os.campaign_application_id IS NULL
        AND EXISTS (SELECT 1 FROM campaign_applications ca
                     WHERE ca.id = $2 AND ca.campaign_id = $3 AND ca.phone8 = $4
                       AND ca.hold_token = $5 AND ca.hold_token <> '')`,
    [orderSubmissionId, appId, campaignId, phone8, holdToken]
  );

  if (!tabMatchesCampaign(camp, sheetId, gid, tabName)) return 'tab_mismatch'; // 확정 보류 — 호출측 관제 로그

  const conf = await client.query(
    `UPDATE campaign_applications
        SET status = 'submitted', submitted_at = NOW(), order_submission_id = $2
      WHERE id = $1 AND campaign_id = $3 AND phone8 = $4
        AND hold_token = $5 AND hold_token IS NOT NULL AND hold_token <> ''
        AND status = 'applied'
        AND expires_at > NOW() - make_interval(secs => $6)
      RETURNING id`,
    [appId, orderSubmissionId, campaignId, phone8, holdToken, HOLD_GRACE_SEC]
  );
  if (conf.rows.length) {
    await maybePersistClosed(client, campaignId);
    return 'confirmed';
  }
  // 지각/스윕 선점/취소 후 제출: 자동확정 없음 — 관제 수동확정 대상 표기(레드 #5·#7의 구제경로 입력)
  await client.query(
    `UPDATE campaign_applications SET late_order_id = $2
      WHERE id = $1 AND campaign_id = $3 AND phone8 = $4 AND hold_token = $5
        AND status IN ('expired','cancelled') AND late_order_id IS NULL`,
    [appId, orderSubmissionId, campaignId, phone8, holdToken]
  );
  return 'late';
}

/** 만료 스윕(정리용 — 판정 SoT는 시각 기준이라 지연·미실행 무해). DB-only, 시트 쿼터 0. */
async function sweepExpiredHolds(pool) {
  // ① grace 경과분만 만료(확정과 동일 경계 → 정시제출 경합 창 0). SKIP LOCKED = 확정 중 행 건너뜀(교착 0, 심판 J6).
  const exp = await pool.query(
    `UPDATE campaign_applications SET status = 'expired'
      WHERE id IN (
        SELECT id FROM campaign_applications
         WHERE status = 'applied' AND expires_at <= NOW() - make_interval(secs => $1)
         ORDER BY id
         FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [HOLD_GRACE_SEC]
  );
  // ② late 백필: 확정 못 한 주문의 provenance 링크가 있으면 관제 수동확정 목록에 노출
  await pool.query(
    `UPDATE campaign_applications a SET late_order_id = o.id
       FROM order_submissions o
      WHERE o.campaign_application_id = a.id AND o.deleted_at IS NULL
        AND a.status = 'expired' AND a.late_order_id IS NULL`
  );
  // ③ closed 영속 백스톱(soft_full 영구표류 방지) — 활성 참여형 전체 1문장(캠페인 수 소량)
  const closed = await pool.query(
    `UPDATE recruit_campaigns rc SET status = 'closed', updated_at = NOW()
      WHERE rc.participation_mode AND rc.status = 'active' AND rc.recruit_total > 0
        AND (SELECT COUNT(*) FROM campaign_applications ca
              WHERE ca.campaign_id = rc.id AND ca.status = 'submitted') >= rc.recruit_total
      RETURNING id`
  );
  if (closed.rowCount) logger.info(`[campaignHold] closed 영속(백스톱): ${closed.rows.map(r => r.id).join(',')}`);
  return { expired: exp.rowCount, closedPersisted: closed.rowCount };
}

module.exports = { HOLD_GRACE_SEC, tabMatchesCampaign, maybePersistClosed, confirmHoldInTx, sweepExpiredHolds };
