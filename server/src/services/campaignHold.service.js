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

/**
 * 시트 일정(063)이 총 건수의 진실원천인 캠페인인지. 이런 캠페인은 마감을 **영속하지 않는다** —
 * status='closed'를 저장해 버리면 나중에 시트에 날짜를 추가해도 상태엔진의 status 게이트가
 * 재개를 막기 때문(자동 재개 보장). 판정 실패는 false(기존 동작 = 영속)로 폴백한다.
 */
async function _isScheduleDriven(q, campaignId) {
  try {
    const { rows } = await q.query(
      `SELECT linked_sheet_id, linked_tab_gid FROM recruit_campaigns
        WHERE id = $1 AND participation_mode LIMIT 1`, [campaignId]);
    const r = rows[0];
    if (!r || !r.linked_sheet_id || !r.linked_tab_gid) return false;
    const { deriveSchedules, scheduleFor } = require('./campaignSchedule.service');
    const m = await deriveSchedules(q, [{ sheetId: r.linked_sheet_id, tabGid: String(r.linked_tab_gid) }]);
    return !!scheduleFor(m, r);
  } catch (_) {
    return false;
  }
}

/** closed 영속 단일 헬퍼 — 자동확정·수동확정·스윕 백스톱 공용. 멱등(WHERE status='active'). */
async function maybePersistClosed(q, campaignId) {
  if (await _isScheduleDriven(q, campaignId)) return;
  await q.query(
    `UPDATE recruit_campaigns rc SET status = 'closed', updated_at = NOW()
      WHERE rc.id = $1 AND rc.participation_mode AND rc.status = 'active' AND rc.recruit_total > 0
        AND (SELECT COUNT(*) FROM campaign_applications ca
              WHERE ca.campaign_id = rc.id AND ca.status = 'submitted') >= rc.recruit_total`,
    [campaignId]
  );
}

/**
 * 타계정 홀드 ↔ 주문 연락처 드리프트 판정(순수함수, 방어 D3).
 *   자리는 "명의"로 소비되는데 시트행·입금·리뷰검색(/api/search 는 phone8 매칭)은 "주문 연락처"로 귀속된다
 *   → 불일치 = 리뷰 캡처 제출 불가 + 정산 오귀속인데, 종전엔 검증도 로그도 없었다(무신호).
 * ★ 오탐 0 설계: (a) 타계정 홀드(owner_phone8 존재 & 명의≠소유자)만 판정 —
 *   자기참여에서 배송용 다른 연락처를 쓰는 것은 정상 패턴이라 신호로 삼지 않는다.
 *   (b) 양쪽이 확실한 8자리일 때만 판정.
 * @returns {{kind:'sub_hold_self_order'|'sub_hold_other_order', orderP8:string}|null}
 */
function detectIdentityDrift(row, orderIdentity) {
  if (!row || !orderIdentity) return null;
  const d = (v) => String(v || '').replace(/\D/g, '').slice(-8);
  const holdP8 = d(row.phone8), ownerP8 = d(row.owner_phone8), orderP8 = d(orderIdentity.phone);
  if (holdP8.length !== 8 || orderP8.length !== 8 || holdP8 === orderP8) return null;
  if (ownerP8.length !== 8 || ownerP8 === holdP8) return null;   // 자기참여·레거시(owner NULL) = 무신호
  return { kind: orderP8 === ownerP8 ? 'sub_hold_self_order' : 'sub_hold_other_order', orderP8 };
}

/**
 * 주문 트랜잭션 안에서 홀드 확정. 반드시 orderLedger의 client 트랜잭션 내부에서 호출.
 * 반환: 'confirmed' | 'late' | 'tab_mismatch' | 'not_found' | 'invalid_params'
 *   — 어떤 반환값이든 주문 저장은 막지 않는다(호출측이 SAVEPOINT로 예외도 격리).
 */
async function confirmHoldInTx(client, { applicationId, campaignId, phone8, holdToken, orderSubmissionId, sheetId, gid, tabName, expectedOptKey, orderIdentity }) {
  const appId = parseInt(applicationId, 10);
  if (!appId || !campaignId || !holdToken || !phone8) return 'invalid_params';

  // 잠금 계층 1: 캠페인 행 — apply·수동확정과 동일 순서(교착 불가)
  const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
  if (!cRows.length || !cRows[0].participation_mode) return 'not_found';
  const camp = cRows[0];

  // provenance 링크: 확정 성패와 무관하게 기록 → 만료건은 스윕이 late_order_id 백필(관제 수동확정 목록 입력).
  //   ★ 소유권 검증을 통과한 신청에만 링크(코드리뷰 #1): applicationId는 클라이언트 입력(SERIAL 추측 가능)이라
  //     무검증 링크는 타인 신청 오염 → 스윕 백필 → 수동확정 오염으로 전파된다.
  // ★ 082: 참여 시점 리뷰비 스냅샷을 주문 원장에도 전파 — 리뷰 내역 화면은 (시트행 ↔ 주문)으로
  //   조회하므로 신청 행에만 있으면 닿지 않는다. COALESCE 로 **이미 있는 값은 안 덮는다**.
  //   (EXISTS → FROM 조인으로 바꿨을 뿐 소유권 검증 조건은 그대로다.)
  await client.query(
    `UPDATE order_submissions os
        SET campaign_application_id = ca.id,
            review_fee_snapshot = COALESCE(os.review_fee_snapshot, ca.review_fee_snapshot)
       FROM campaign_applications ca
      WHERE os.id = $1 AND os.campaign_application_id IS NULL
        AND ca.id = $2 AND ca.campaign_id = $3 AND ca.phone8 = $4
        AND ca.hold_token = $5 AND ca.hold_token <> ''`,
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
      RETURNING id, option_key, phone8, owner_phone8`,
    [appId, orderSubmissionId, campaignId, phone8, holdToken, HOLD_GRACE_SEC]
  );
  if (conf.rows.length) {
    // ★ 옵션 드리프트 관측(063 · 옵션권위 TOCTOU 백스톱): 시트기입 옵션(제출 시점 서버권위 스냅샷)과 확정 시점
    //   홀드 옵션이 다르면 경고만(주문·확정 비차단 — 시트=옛옵션·DB=새옵션을 관제가 대조할 신호).
    //   1차 방어는 UI 단일 iframe 재로드(옵션변경·명의전환 공통), 이것은 백스톱.
    //   옵션 없는 홀드(option_key NULL)는 비교 무의미(시트 옵션피커 클라값과 상시 상이) — 오탐 방지 위해 제외.
    const _dbOpt = conf.rows[0].option_key || '';
    if (_dbOpt && expectedOptKey !== undefined && expectedOptKey !== null && String(expectedOptKey || '') !== _dbOpt) {
      logger.warn(`[campaignHold] 옵션 드리프트 감지 app=${appId} 시트기입=${expectedOptKey || '∅'} 홀드=${_dbOpt} — 관제 대조 필요`);
    }
    // ★ 방어 D3: 명의 드리프트는 "경고만" — 주문 손실 0 계약(이미 결제한 리뷰어를 막지 않는다)을 지킨다.
    //   관제가 대조할 신호이며, 오귀속 정정은 수동확정/주문정정 기존 경로가 담당한다.
    const _drift = detectIdentityDrift(conf.rows[0], orderIdentity);
    if (_drift) {
      logger.warn(`[campaignHold] 명의 드리프트 감지 app=${appId} kind=${_drift.kind} ` +
        `홀드명의=***${String(conf.rows[0].phone8).slice(-4)} 주문연락처=***${_drift.orderP8.slice(-4)} — 관제 대조 필요`);
    }
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
  // ③ closed 영속 백스톱(soft_full 영구표류 방지). ★ 후보를 먼저 뽑고 시트 일정 캠페인은 제외 —
  //    영속하면 시트에 날짜를 추가해도 재개되지 않기 때문(063 자동 재개 보장).
  const cand = await pool.query(
    `SELECT rc.id, rc.linked_sheet_id, rc.linked_tab_gid FROM recruit_campaigns rc
      WHERE rc.participation_mode AND rc.status = 'active' AND rc.recruit_total > 0
        AND (SELECT COUNT(*) FROM campaign_applications ca
              WHERE ca.campaign_id = rc.id AND ca.status = 'submitted') >= rc.recruit_total`
  );
  let ids = cand.rows.map(r => r.id);
  if (ids.length) {
    try {
      const { deriveSchedules, scheduleFor } = require('./campaignSchedule.service');
      const tabs = cand.rows
        .filter(r => r.linked_sheet_id && r.linked_tab_gid)
        .map(r => ({ sheetId: r.linked_sheet_id, tabGid: String(r.linked_tab_gid) }));
      const m = await deriveSchedules(pool, tabs);
      ids = cand.rows.filter(r => !scheduleFor(m, r)).map(r => r.id);
    } catch (_) { /* 판정 실패 = 기존 동작(전부 영속)으로 폴백 */ }
  }
  let closedCount = 0;
  if (ids.length) {
    const closed = await pool.query(
      `UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW()
        WHERE id = ANY($1) AND status = 'active' RETURNING id`, [ids]);
    closedCount = closed.rowCount;
    if (closedCount) logger.info(`[campaignHold] closed 영속(백스톱): ${closed.rows.map(r => r.id).join(',')}`);
  }
  return { expired: exp.rowCount, closedPersisted: closedCount };
}

module.exports = { HOLD_GRACE_SEC, tabMatchesCampaign, maybePersistClosed, confirmHoldInTx, detectIdentityDrift, sweepExpiredHolds };
