-- 154: 리뷰 캡처 중복 차단의 완료 행 확인 인덱스.
-- review_submissions.file_hash 로 후보를 먼저 줄인 뒤 정확한 구매양식 행과 제출완료 여부를 확인한다.

CREATE INDEX IF NOT EXISTS idx_review_index_duplicate_row
  ON review_index (sheet_id, tab_name, row_index)
  INCLUDE (is_submitted, phone8, recipient_name);
