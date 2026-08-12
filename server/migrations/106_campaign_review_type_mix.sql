-- 모집공고 리뷰타입이 혼합일 때, 유형별 모집 수량을 명시적으로 보관한다.
-- 빈 배열은 미지정/단일 타입 공고 및 기존 공고의 호환값이다.
ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS review_type_mix JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE recruit_campaigns
  DROP CONSTRAINT IF EXISTS recruit_campaigns_review_type_mix_is_array;

ALTER TABLE recruit_campaigns
  ADD CONSTRAINT recruit_campaigns_review_type_mix_is_array
  CHECK (jsonb_typeof(review_type_mix) = 'array');
