-- 227: 네이버예약리뷰 날짜별 자리표 — 결정 404·407 (2단계 · 2026-11-24).
--
-- 한 줄 = 「이 날 · 이 매장에서 한 명」. 날짜·날짜별 인원은 업체가 오더에 정한 그대로(utils/bookingCalendar 계약).
-- 접수(무시트 작업표 생성) 때 작업오더에서 한 번 만든다. 작업표 줄(campaign_participants)은 이 표의 사본을
-- 칸(이용일자·리뷰마감일)으로 보여 줄 뿐이고, 3단계 신청 때 리뷰어가 고른 날의 남은 자리를 고르는 기준은 이 표다
-- (작업표 날짜는 자동 정리가 옮길 수 있는 값이라 믿지 않는다 — 결정 321 「작업표 행 날짜는 믿을 수 없다」).
--   seq             = 그 자리의 작업표 줄 번호(campaign_participants.seq)
--   slot_date       = 이용일(업체가 정한 날)
--   date_seq        = 그 날 안 순번(1..그날 인원)
--   review_deadline = 리뷰 마감일(이용일 + N일 · 오더 값)
--   status          = 'open' | 'cancelled'
-- ★ 3단계(신청)에서 campaign_applications.booking_slot_id + 부분 유일 색인(같은 자리에 둘 금지)을 더한다 —
--   Q&A 211 과 같은 방식(과판매 방지는 자리 한 줄 = 신청 하나 유일 색인이 맡는다).
-- ★ 가산 전용 · CHECK/FK 없음(082·137 규율) · 러너가 매 기동 시 재실행하므로 멱등.
-- 롤백: DROP TABLE booking_slots (코드가 먼저 되돌아가 있어야 한다 — 없는 표는 조회 실패 = 예약 탭으로 보고 자동 정리를 쉰다).

CREATE TABLE IF NOT EXISTS booking_slots (
  id              BIGSERIAL PRIMARY KEY,
  work_order_id   TEXT NOT NULL,
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  seq             INTEGER,
  slot_date       DATE NOT NULL,
  date_seq        INTEGER NOT NULL,
  review_deadline DATE,
  status          TEXT NOT NULL DEFAULT 'open',
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_slots_day ON booking_slots (sheet_id, tab_name, slot_date, date_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_slots_row ON booking_slots (sheet_id, tab_name, seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_slots_open ON booking_slots (sheet_id, tab_name, slot_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_booking_slots_wo   ON booking_slots (work_order_id);
