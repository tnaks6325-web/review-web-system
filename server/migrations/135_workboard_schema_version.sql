-- New workboard column rules are versioned per original work order.
-- Existing work orders stay v1 and must never be reclassified by a template change.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS workboard_schema_version SMALLINT NOT NULL DEFAULT 1
  CHECK (workboard_schema_version IN (1, 2));
