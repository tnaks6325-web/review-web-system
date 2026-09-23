/**
 * reviewerOrderCancel.service.js — 리뷰어가 스스로 하는 주문취소 (2026-08-23 사용자 확정)
 *
 * ★★ 파괴 로직을 새로 만들지 않는다. 실행부는 작업보드 [행 삭제]와 **같은 함수**
 *    (`trackB.hideParticipant` → `cancelOrderSubmission` + `_hideParticipantInTx`):
 *    주문 무효 → 큐 정리 → 자리 반환 → 작업표 줄 제거 → **보충 슬롯**(총 건수 불변)
 *    → 표 번호 재부여 → 장부 재생성. 사본을 두면 "리뷰어가 취소하면 보충이 안 되는"
 *    드리프트가 조용히 생긴다.
 *
 * ★★ 막을 것(fail-closed) — 완화 금지:
 *    ① 리뷰 제출 완료   결과물이 이미 있다(업체에 전달될 수 있다)
 *    ② 리뷰비 입금 완료 이미 돈이 나갔다
 *    ③ 시트 기반 작업   지워도 다음 시트 반영이 되살린다(`_hideParticipantInTx` 가 최종 방어)
 *    ④ 판정 실패        모르는 채로 지우지 않는다
 *    (③은 운영상 사실상 사라졌지만 게이트는 남긴다 — 하나라도 생기면 그 순간 필요하다.)
 *
 * ★ 취소 뒤 **당일 재참여는 열려 있다**(사용자 확정 ㉯) — 참여 게이트가 전부
 *   `status='submitted'` 기준인데 취소가 그 행을 `cancelled` 로 바꾸기 때문이다.
 *   그래서 이 파일이 게이트를 손대지 않는다(코드 변경 0으로 성립).
 */
const { logger } = require('../utils/logger');

/** 리뷰어에게 보여줄 사유 — 화면·서버가 같은 문장을 쓴다(사본 금지). */
const CANCEL_BLOCK_REASONS = {
  no_row: '이 참여를 찾을 수 없어요. 새로고침 후 다시 확인해주세요.',
  no_order: '구매양식 제출 기록이 없어 취소할 것이 없어요.',
  review_submitted: '리뷰를 이미 제출하셨어요 — 취소가 필요하면 1:1 문의로 알려주세요.',
  paid: '리뷰비가 이미 입금되어 스스로 취소할 수 없어요 — 1:1 문의로 알려주세요.',
  sheet_based: '이 작업은 담당자 확인이 필요해요 — 1:1 문의로 알려주세요.',
  unknown: '지금은 확인이 어려워요. 잠시 후 다시 시도해주세요.',
};

/** 사유 선택지 — 화면이 서버 목록을 그대로 그린다(문구 사본 0). */
const CANCEL_REASONS = [
  { key: 'soldout', label: '품절이라 구매하지 못했어요' },
  { key: 'price', label: '화면과 가격이 달라요' },
  { key: 'personal', label: '개인 사정으로 진행이 어려워요' },
];
function cancelReasonLabel(key) {
  const r = CANCEL_REASONS.find(x => x.key === String(key || ''));
  return r ? r.label : '';
}

/**
 * 취소 가능 여부 — **읽기 전용**. 화면 게이트(버튼 노출)와 실제 실행이 같은 판정을 쓴다.
 * @returns {{cancelable:boolean, reason:string|null, message:string, rowId:string|null, orderSubmissionId:string|null}}
 */
async function assessReviewerCancel(db, { sheetId, tabName, rowIndex } = {}) {
  const deny = (reason) => ({ cancelable: false, reason, message: CANCEL_BLOCK_REASONS[reason] || CANCEL_BLOCK_REASONS.unknown, rowId: null, orderSubmissionId: null });
  const seq = Number(rowIndex);
  if (!sheetId || !tabName || !Number.isInteger(seq)) return deny('no_row');
  let row, sheetless, paid, riSubmitted;
  try {
    const { rows } = await db.query(
      `SELECT cp.id, cp.order_submission_id AS oid,
              COALESCE(cp.is_submitted,FALSE) AS cp_submitted,
              COALESCE(cp.is_paid,FALSE)      AS cp_paid,
              COALESCE(tc.sheetless,FALSE)    AS sheetless,
              COALESCE(ri.is_submitted,FALSE) AS ri_submitted,
              EXISTS (SELECT 1 FROM payment_batch_items pb
                       WHERE pb.sheet_id=cp.sheet_id AND pb.tab_name=cp.tab_name
                         AND pb.row_index=cp.seq AND pb.status='paid') AS pay_paid
         FROM campaign_participants cp
         LEFT JOIN tab_configs   tc ON tc.sheet_id=cp.sheet_id AND tc.tab_name=cp.tab_name
         LEFT JOIN review_index  ri ON ri.sheet_id=cp.sheet_id AND ri.tab_name=cp.tab_name AND ri.row_index=cp.seq
        WHERE cp.sheet_id=$1 AND cp.tab_name=$2 AND cp.seq=$3
          AND cp.deleted_at IS NULL AND cp.active=TRUE
        LIMIT 1`, [sheetId, tabName, seq]);
    if (!rows.length) return deny('no_row');
    row = rows[0];
    sheetless = row.sheetless === true;
    paid = row.cp_paid === true || row.pay_paid === true;
    riSubmitted = row.ri_submitted === true;
  } catch (e) {
    // ★ 모르면 열지 않는다 — 입금·제출 여부를 못 읽은 채로 지우지 않는다.
    logger.warn(`[reviewer-cancel] 판정 조회 실패 tab=${tabName} row=${rowIndex}: ${(e && e.message) || e}`);
    return deny('unknown');
  }
  if (!row.oid) return deny('no_order');
  if (row.cp_submitted === true || riSubmitted) return deny('review_submitted');
  if (paid) return deny('paid');
  if (!sheetless) return deny('sheet_based');
  return { cancelable: true, reason: null, message: '', rowId: row.id, orderSubmissionId: row.oid };
}

/**
 * 실제 취소. 게이트를 **다시 통과시킨 뒤**(TOCTOU) 작업보드와 같은 실행부를 부른다.
 * 로그·1:1문의 안내는 **커밋 뒤**에 하고, 실패해도 취소를 되돌리지 않는다(이미 끝난 일).
 */
async function cancelOrderByReviewer({ sheetId, tabName, rowIndex, phone8 = '', reviewerName = '', reasonKey = '', reasonEtc = '', pool } = {}) {
  const db = pool || require('../db/pool');
  const gate = await assessReviewerCancel(db, { sheetId, tabName, rowIndex });
  if (!gate.cancelable) return { ok: false, code: gate.reason, error: gate.message };

  const label = cancelReasonLabel(reasonKey);
  const etc = String(reasonEtc || '').trim().slice(0, 200);
  const reasonText = [label, etc].filter(Boolean).join(' · ');

  const trackB = require('./trackB.service');
  const by = `reviewer:${String(phone8 || '').slice(-4)}`;
  /* ★ `actorRole` 을 넘기지 않는다 — 그 게이트는 "담당자가 남의 구매기록을 지우는" 경우를 막는
       것이고, 여기는 **본인 것**이다(소유권은 라우트가 강한 키로 이미 확인했다). */
  const out = await trackB.hideWorkdeskRow({ sheetId, tabName, rowId: gate.rowId, by });
  if (!out || out.ok !== true) {
    return { ok: false, code: (out && out.error) || 'cancel_failed', error: CANCEL_BLOCK_REASONS[(out && out.error)] || '취소하지 못했습니다. 잠시 후 다시 시도해주세요.' };
  }

  /* ── 커밋 뒤 후처리 — 둘 다 실패해도 취소는 유효하다 ── */
  let logged = false, notified = false;
  try {
    const { logReviewerEvent } = require('./reviewerEventLog.service');
    const r = await logReviewerEvent({
      sheetId, tabName, reviewerName, phone8,
      eventType: 'order_canceled_by_reviewer',
      severity: 'info',
      // ★ resolved=true — 담당자가 손볼 것이 없는 '사실 기록'이다(미확인 알림으로 쌓지 않는다).
      resolved: true,
      message: `${reviewerName || '리뷰어'} 님이 주문을 취소했습니다${reasonText ? ` — ${reasonText}` : ''}`,
      context: { rowIndex: Number(rowIndex), reasonKey: String(reasonKey || ''), reasonEtc: etc },
      orderSubmissionId: gate.orderSubmissionId,
    });
    logged = !!(r && r.ok);
  } catch (e) { logger.warn(`[reviewer-cancel] 로그 실패(무시): ${(e && e.message) || e}`); }

  try {
    const csBridge = require('./csBridge.service');
    const note = await csBridge.postAdminNotice({
      sheetId, tabName, rowIndex: Number(rowIndex), reviewerName, phone8,
      by: '시스템',
      message: `주문취소가 접수되었습니다${reasonText ? `\n사유: ${reasonText}` : ''}\n\n`
        + '구매양식 제출이 무효 처리되고 작업 명단에서도 빠졌어요.\n'
        + '착오가 있거나 다시 진행하고 싶으시면 이 채팅으로 알려주세요.',
    });
    notified = !!note;
  } catch (e) { logger.warn(`[reviewer-cancel] 문의방 안내 실패(무시): ${(e && e.message) || e}`); }

  logger.info(`[reviewer-cancel] tab=${tabName} row=${rowIndex} order=${gate.orderSubmissionId} reason=${reasonKey || '-'} log=${logged} cs=${notified}`);
  return { ok: true, logged, notified, orderSubmissionId: gate.orderSubmissionId };
}

module.exports = { CANCEL_REASONS, CANCEL_BLOCK_REASONS, cancelReasonLabel, assessReviewerCancel, cancelOrderByReviewer };
