-- 117: 2026-08-11 수동 입금 이력의 영구 원장화.
-- 기존 participant_edits 는 "누가 수기로 8/11을 적었는가"만 남겼고, 작업표 재구성 뒤
-- 회차/입금원장 근거가 없었다. #0 회차와 아래 마커가 재생성의 단일 복구 근거다.

ALTER TABLE payment_batches
  ADD COLUMN IF NOT EXISTS historical_key TEXT;

ALTER TABLE payment_batches
  DROP CONSTRAINT IF EXISTS ck_payment_batches_bank;
ALTER TABLE payment_batches
  ADD CONSTRAINT ck_payment_batches_bank CHECK (bank IN ('kbank','hana','manual'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_batches_historical_key
  ON payment_batches(historical_key) WHERE historical_key IS NOT NULL;

ALTER TABLE payment_records
  ADD COLUMN IF NOT EXISTS source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_records_source_key
  ON payment_records(source_key) WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_payment_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL UNIQUE,
  batch_id UUID NOT NULL REFERENCES payment_batches(id) ON DELETE RESTRICT,
  sheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  anchor_type TEXT NOT NULL,
  anchor_value TEXT NOT NULL,
  deposit_col_key TEXT NOT NULL,
  stamp TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manual_payment_marks_tab
  ON manual_payment_marks(sheet_id, tab_name);
