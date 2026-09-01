-- 상품·옵션 작업표 배정 순서. 기존 오더도 새 기본값(균등 분산)으로 읽는다.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS product_distribution_mode TEXT NOT NULL DEFAULT 'balanced';

ALTER TABLE work_orders
  DROP CONSTRAINT IF EXISTS work_orders_product_distribution_mode_check;

ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_product_distribution_mode_check
  CHECK (product_distribution_mode IN ('balanced', 'sequential'));
