-- ============================================================
-- Phase 3-4: 제출 안정화 + 중복검사 최적화를 위한 인덱스 추가
-- ============================================================

-- order_submissions 중복 검사 최적화 인덱스
CREATE INDEX IF NOT EXISTS idx_order_recipient_phone
  ON order_submissions(recipient, phone);
CREATE INDEX IF NOT EXISTS idx_order_recipient_address
  ON order_submissions(recipient, address);
CREATE INDEX IF NOT EXISTS idx_order_recent
  ON order_submissions(sheet_id, tab_name, user_id, submitted_at);

-- review_index phone8 + sheet_id + tab_name 복합 인덱스 (중복검사용)
CREATE INDEX IF NOT EXISTS idx_review_sheet_tab_phone
  ON review_index(sheet_id, tab_name, phone8);
