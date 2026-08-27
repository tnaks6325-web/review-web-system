-- v2 작업표의 차수는 탭명이나 캠페인 행 수가 아니라 원본 오더 계열에서만 판정한다.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS work_series_id TEXT NOT NULL DEFAULT '';

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS work_round INTEGER NOT NULL DEFAULT 1
  CHECK (work_round >= 1);

CREATE INDEX IF NOT EXISTS idx_work_orders_work_series_round
  ON work_orders(work_series_id, work_round)
  WHERE work_series_id <> '';
