-- 148: 상품명 의심 군집판단 + 유형별 사람 판정
--
-- 기존 resolution 은 검수 건 전체의 정상/불량이라, 중복·형식 불량이 함께 있는 건을
-- 상품명 정답으로 재사용할 수 없다. 상품명 축만 별도 기록하고 동일 군집을 한 번에
-- 종결한다. 학습 규칙은 tab_configs 에 작업별 JSONB 로 둬 다른 상품/작업으로 번지지 않는다.

ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS product_resolution TEXT;
ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS product_resolution_note TEXT;
ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS product_resolved_at TIMESTAMPTZ;
ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS product_resolved_by TEXT;
ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS product_cluster_key TEXT;

COMMENT ON COLUMN review_inspections.product_resolution IS
  '상품명 축 사람 판정: pass | fail | unknown | baseline_error';
COMMENT ON COLUMN review_inspections.product_cluster_key IS
  '같은 작업·기대상품 후보·OCR 표기를 묶는 안정 키';

ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS inspect_product_rules JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN tab_configs.inspect_product_rules IS
  '상품명 군집 사람 판정에서 만든 작업 한정 exact 규칙 목록';

CREATE INDEX IF NOT EXISTS idx_review_inspect_product_cluster
  ON review_inspections(sheet_id, tab_name, product_cluster_key)
  WHERE product_cluster_key IS NOT NULL;
