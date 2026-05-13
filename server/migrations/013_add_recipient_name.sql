-- 013: review_index에 recipient_name 컬럼 추가
-- 검색 시 reviewer_name(주문자제출) 외에 수취인명으로도 조회 가능하도록
ALTER TABLE review_index ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE review_index_archive ADD COLUMN IF NOT EXISTS recipient_name TEXT;

-- 수취인명 검색용 인덱스 (pg_trgm GIN)
CREATE INDEX IF NOT EXISTS idx_review_index_recipient_name
  ON review_index (recipient_name)
  WHERE recipient_name IS NOT NULL AND recipient_name != '';

-- 공백 제거 정확 매칭용 인덱스
CREATE INDEX IF NOT EXISTS idx_review_index_recipient_replace
  ON review_index (REPLACE(recipient_name, ' ', ''))
  WHERE recipient_name IS NOT NULL AND recipient_name != '';
