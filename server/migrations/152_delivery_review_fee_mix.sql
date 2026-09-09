-- 혼합 배송(실배송/빈박스)별 리뷰비.
-- 기존 단일 review_fee는 레거시·단일배송·매핑 미설정 폴백으로 그대로 보존한다.
ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS delivery_review_fee_mix JSONB NOT NULL DEFAULT '[]'::jsonb;
