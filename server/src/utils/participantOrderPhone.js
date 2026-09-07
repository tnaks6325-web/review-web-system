'use strict';

function phone8Of(value) {
  return String(value || '').replace(/\D/g, '').slice(-8);
}

/**
 * 서버에서 확인한 참여 신청행을 기준으로 주문 연락처를 확정한다.
 *
 * 본계정은 배송용 연락처를 따로 쓸 수 있는 기존 흐름을 유지한다. 반면 타계정 참여는
 * 신청행의 applicant_phone/phone8이 재참여·정산 귀속의 단일 기준이므로 클라이언트가
 * 다른 값을 보내더라도 등록된 타계정 번호로 저장한다.
 */
function resolveParticipantOrderPhone({
  requestedPhone,
  participantPhone,
  participantPhone8,
  ownerPhone8,
  verified,
} = {}) {
  const requested = String(requestedPhone || '').trim();
  const selected8 = phone8Of(participantPhone8);
  const owner8 = phone8Of(ownerPhone8);
  const isSubAccount = verified === true
    && selected8.length === 8
    && owner8.length === 8
    && selected8 !== owner8;

  if (!isSubAccount) {
    return { ok: true, phone: requested, isSubAccount: false, forced: false };
  }

  const registered = String(participantPhone || '').trim();
  if (!registered || phone8Of(registered) !== selected8) {
    return {
      ok: false,
      phone: '',
      isSubAccount: true,
      forced: false,
      code: 'PARTICIPANT_PHONE_INVALID',
      error: '타계정 등록 전화번호를 확인할 수 없습니다. 내정보의 타계정 번호를 확인한 뒤 다시 참여해주세요.',
    };
  }

  return {
    ok: true,
    phone: registered,
    isSubAccount: true,
    forced: requested !== registered,
  };
}

module.exports = { phone8Of, resolveParticipantOrderPhone };
