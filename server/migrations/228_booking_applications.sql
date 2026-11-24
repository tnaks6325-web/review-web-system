-- 228: 네이버예약리뷰 3단계 — 신청 ↔ 날짜별 자리 묶기 + 예약번호 (결정 404·407·408 · 2026-11-24).
--
-- 리뷰어가 신청하면서 고른 날의 **빈 자리 하나**가 그 신청에 묶인다(campaign_applications.booking_slot_id).
--   자리가 비었는지 = 이 자리를 가리키는 신청이 「제출 완료」이거나 「살아 있는 홀드」가 아님.
--   그래서 자리표(booking_slots.status)는 신청·만료·취소 때 고치지 않는다 — 신청 표가 단일 출처다(Q&A 211 과 같은 방식).
-- ★ 한 자리에 두 신청이 묶이지 않게 부분 유일 색인(살아 있는 신청만 — 만료·취소된 신청은 자리를 놓는다).
--   동시 신청이 마지막 한 자리를 함께 노려도 색인이 하나만 받는다(과판매 구조적 차단).
-- ★ 예약번호(booking_reservation_no) — 예약내역 제출 때 리뷰어가 적은 네이버 예약번호(정규화 값).
--   같은 공고에서 같은 예약번호를 두 신청이 쓰지 못하게 부분 유일 색인(살아 있는 신청만 — 취소된 신청의 번호는 다시 쓸 수 있다).
-- ★ 가산 전용 · CHECK/FK 없음(082·137 규율) · 러너가 매 기동 시 재실행하므로 멱등.
-- 롤백: DROP INDEX uq_campaign_apps_booking_resv; DROP INDEX uq_campaign_apps_booking_slot;
--       ALTER TABLE campaign_applications DROP COLUMN booking_reservation_no, DROP COLUMN booking_slot_id;
--   (코드가 먼저 되돌아가 있어야 한다 — 칸이 없으면 기동 필수 스키마 검사가 부팅을 막는다)

ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS booking_slot_id BIGINT;
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS booking_reservation_no TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_booking_slot
  ON campaign_applications (booking_slot_id)
  WHERE booking_slot_id IS NOT NULL AND status IN ('applied', 'submitted');

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_booking_resv
  ON campaign_applications (campaign_id, booking_reservation_no)
  WHERE booking_reservation_no IS NOT NULL AND status IN ('applied', 'submitted');

COMMENT ON COLUMN campaign_applications.booking_slot_id IS '네이버예약리뷰(결정 408) — 이 신청이 차지한 날짜별 자리(booking_slots.id). 다른 종류 신청은 NULL.';
COMMENT ON COLUMN campaign_applications.booking_reservation_no IS '네이버예약리뷰(결정 408) — 예약내역 제출 때 받은 네이버 예약번호(정규화). 같은 공고 안에서 살아 있는 신청끼리 겹치지 않는다.';
