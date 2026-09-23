-- 관리자가 작업보드 표시금액과 실제 이체금액을 확인한 뒤 승인한 금액 불일치 건의 감사 이력.
-- 회차 원본 스냅샷은 덮어쓰지 않고 expected/workboard/actual 세 값을 모두 보존한다.
CREATE TABLE IF NOT EXISTS payment_amount_mismatch_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  upload_id UUID NOT NULL REFERENCES payment_result_uploads(id) ON DELETE CASCADE,
  result_seq INTEGER NOT NULL,
  batch_item_id UUID NOT NULL REFERENCES payment_batch_items(id) ON DELETE RESTRICT,
  expected_amount NUMERIC(14,2) NOT NULL,
  workboard_product_amount NUMERIC(14,2) NOT NULL,
  review_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  workboard_amount NUMERIC(14,2) NOT NULL,
  actual_amount NUMERIC(14,2) NOT NULL,
  review_note TEXT NOT NULL,
  reconciled_by TEXT NOT NULL DEFAULT '',
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, result_seq),
  UNIQUE (batch_item_id)
);
