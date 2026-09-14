-- 자주 쓰는 주문정보 추천: 명의 검증을 통과한 제출에 불변 소유자 결속을 남긴다.
-- 전화번호만 남은 과거 주문은 번호 재할당 시 타인 주소가 노출될 수 있어 사용하지 않는다.

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS participant_identity_key_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_campaign_apps_order_info_identity
  ON campaign_applications (owner_reviewer_id, participant_identity_id, id)
  WHERE owner_reviewer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_submissions_order_info_active
  ON order_submissions (owner_reviewer_id, participant_identity_key_hash, submitted_at DESC)
  WHERE owner_reviewer_id IS NOT NULL
    AND participant_identity_key_hash IS NOT NULL
    AND deleted_at IS NULL
    AND source = 'order_submit';
