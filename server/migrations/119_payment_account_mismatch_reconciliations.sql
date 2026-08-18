-- 관리자 확인을 거친 계좌 불일치 이체 결과의 감사 이력. 한 결과 행·대상 항목은 한 번만 대조한다.
CREATE TABLE IF NOT EXISTS payment_account_mismatch_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  upload_id UUID NOT NULL REFERENCES payment_result_uploads(id) ON DELETE CASCADE,
  result_seq INTEGER NOT NULL,
  batch_item_id UUID NOT NULL REFERENCES payment_batch_items(id) ON DELETE RESTRICT,
  expected_account_tail TEXT NOT NULL,
  result_account_tail TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  reconciled_by TEXT NOT NULL DEFAULT '',
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, result_seq),
  UNIQUE (batch_item_id)
);
