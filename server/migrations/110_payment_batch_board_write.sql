-- Persist the real workboard write outcome separately from bank-result application.
ALTER TABLE payment_batches
  ADD COLUMN IF NOT EXISTS board_recorded_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS board_queued_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS board_skipped_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS board_failed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS board_stamp TEXT,
  ADD COLUMN IF NOT EXISTS board_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS board_recorded_by TEXT;
