-- 옵션 있는 혼합 리뷰 공고는 옵션별 리뷰 방식·수량을 원장에 보존한다.
-- 빈 배열은 단일 리뷰타입·기존 옵션의 안전한 호환값이다.
ALTER TABLE campaign_options
  ADD COLUMN IF NOT EXISTS review_type_mix JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE campaign_options
  DROP CONSTRAINT IF EXISTS campaign_options_review_type_mix_is_array;

ALTER TABLE campaign_options
  ADD CONSTRAINT campaign_options_review_type_mix_is_array
  CHECK (jsonb_typeof(review_type_mix) = 'array');
