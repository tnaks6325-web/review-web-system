-- 자주 쓰는 주문정보 추천: 코드 신원 경로와 활성 주문 조인을 위한 인덱스.
-- 레거시 phone8 폴백은 조회 쿼리에서 별도 분기해 UUID 인덱스 사용을 방해하지 않는다.

CREATE INDEX IF NOT EXISTS idx_campaign_apps_order_info_identity
  ON campaign_applications (owner_reviewer_id, participant_identity_id, id)
  WHERE owner_reviewer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_submissions_order_info_active
  ON order_submissions (campaign_application_id, submitted_at DESC)
  WHERE campaign_application_id IS NOT NULL
    AND deleted_at IS NULL
    AND source = 'order_submit';
