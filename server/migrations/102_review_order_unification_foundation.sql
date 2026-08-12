-- 102: 인트라넷 리뷰오더 → 리뷰웹 작업오더의 원본 식별·재시도 기반.
--
-- source_review_order_id 는 인트라넷의 원본 오더 ID다. 비어 있는 값은 과거
-- 수기/구형 전송 호환이며, 새 계약을 쓰는 행만 DB 유니크 제약으로 보호한다.
-- intake_idempotency_key 는 네트워크 재시도 중복을 막는 별도 식별자다.

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS source_review_order_id TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_revision INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intake_idempotency_key TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS intranet_advertiser_id TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS intranet_advertiser_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS intranet_advertiser_contact TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS intranet_advertiser_business_number TEXT DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_source_review_order
  ON work_orders (source_review_order_id)
  WHERE source_review_order_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_intake_idempotency_key
  ON work_orders (intake_idempotency_key)
  WHERE intake_idempotency_key <> '';

CREATE INDEX IF NOT EXISTS idx_work_orders_intranet_advertiser_id
  ON work_orders (intranet_advertiser_id)
  WHERE intranet_advertiser_id <> '';
