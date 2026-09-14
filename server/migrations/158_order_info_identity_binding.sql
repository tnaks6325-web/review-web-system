-- 추천용 주문 이력은 명의 검증 시점의 불변 소유자 UUID와 참여 명의 해시에 결속한다.
-- 이미 실행된 157 마이그레이션은 수정하지 않고 후속 파일로 가산한다.

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS participant_identity_key_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_order_submissions_owner_identity_suggestions
  ON order_submissions (owner_reviewer_id, participant_identity_key_hash, submitted_at DESC)
  WHERE owner_reviewer_id IS NOT NULL
    AND participant_identity_key_hash IS NOT NULL
    AND deleted_at IS NULL
    AND source = 'order_submit';
