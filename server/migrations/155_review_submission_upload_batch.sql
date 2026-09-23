-- 155: 한 번의 리뷰 업로드 요청에 포함된 여러 캡처를 같은 제출 묶음으로 보존한다.
-- 기존 행은 NULL로 남겨 대표 캡처만 완료 파일로 인정하고, 신규 업로드부터 묶음 전부를 판정한다.

ALTER TABLE review_submissions
  ADD COLUMN IF NOT EXISTS upload_batch_id UUID,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_review_sub_upload_batch
  ON review_submissions (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_sub_completed_hash
  ON review_submissions (file_hash)
  WHERE completed_at IS NOT NULL;
