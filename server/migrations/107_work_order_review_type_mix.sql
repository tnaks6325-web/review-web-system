-- 인트라넷 리뷰오더의 혼합 리뷰 수량을 작업오더 원장까지 보존한다.
-- 문자열 요약(review_type)만 전달하면 모집공고에서 동일한 조합을 재현할 수 없다.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS review_type_mix JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE work_orders
  DROP CONSTRAINT IF EXISTS work_orders_review_type_mix_is_array;

ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_review_type_mix_is_array
  CHECK (jsonb_typeof(review_type_mix) = 'array');
