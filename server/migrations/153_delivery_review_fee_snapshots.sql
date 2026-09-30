-- 153: 혼합 배송별 리뷰비는 신청 시점 설정을 보존한다.
ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS delivery_review_fee_mix_snapshot JSONB;

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS delivery_review_fee_mix_snapshot JSONB;
