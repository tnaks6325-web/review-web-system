-- 035: DB order ledger + raw mirror detected headers + sheet row claims
-- Idempotent, additive migration. Existing submissions and raw mirror data are preserved.

ALTER TABLE raw_sheet_tabs
  ADD COLUMN IF NOT EXISTS header_row_index INTEGER,
  ADD COLUMN IF NOT EXISTS detected_headers JSONB,
  ADD COLUMN IF NOT EXISTS data_start_row INTEGER;

CREATE INDEX IF NOT EXISTS idx_raw_tabs_detected_header
  ON raw_sheet_tabs(sheet_id, tab_gid)
  WHERE detected_headers IS NOT NULL;

CREATE TABLE IF NOT EXISTS sheet_row_claims (
  id          BIGSERIAL PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  tab_gid     TEXT,
  tab_name    TEXT NOT NULL,
  sheet_row   INTEGER NOT NULL,
  dedup_key   TEXT NOT NULL,
  order_id    UUID,
  name        TEXT,
  phone8      TEXT,
  source      TEXT DEFAULT 'order_submit',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sheet_row_claims_row
  ON sheet_row_claims (sheet_id, tab_name, sheet_row);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sheet_row_claims_dedup
  ON sheet_row_claims (sheet_id, tab_name, dedup_key);

CREATE INDEX IF NOT EXISTS idx_sheet_row_claims_gid
  ON sheet_row_claims (sheet_id, tab_gid)
  WHERE tab_gid IS NOT NULL;

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS tab_gid TEXT,
  ADD COLUMN IF NOT EXISTS sheet_row INTEGER,
  ADD COLUMN IF NOT EXISTS dedup_key TEXT,
  ADD COLUMN IF NOT EXISTS bank TEXT,
  ADD COLUMN IF NOT EXISTS account TEXT,
  ADD COLUMN IF NOT EXISTS depositor TEXT,
  ADD COLUMN IF NOT EXISTS price TEXT,
  ADD COLUMN IF NOT EXISTS memo TEXT,
  ADD COLUMN IF NOT EXISTS mirror_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS sheet_written_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sheet_error TEXT,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;

UPDATE order_submissions
   SET tab_gid = COALESCE(NULLIF(tab_gid, ''), NULLIF(gid, ''))
 WHERE (tab_gid IS NULL OR tab_gid = '') AND gid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_submissions_dedup
  ON order_submissions(sheet_id, tab_name, dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_submissions_mirror_status
  ON order_submissions(mirror_status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_submissions_sheet_row
  ON order_submissions(sheet_id, tab_name, sheet_row)
  WHERE sheet_row IS NOT NULL;
