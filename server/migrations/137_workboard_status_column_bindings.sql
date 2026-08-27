-- v2 status columns are an immutable per-tab contract, not keyword matches.
ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS workboard_schema_version SMALLINT NOT NULL DEFAULT 1
  CHECK (workboard_schema_version IN (1, 2));

CREATE TABLE IF NOT EXISTS tab_status_column_bindings (
  sheet_id TEXT NOT NULL,
  tab_gid TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('review_submit', 'payment_status')),
  header_text TEXT NOT NULL,
  col_index INTEGER NOT NULL CHECK (col_index >= 0),
  workboard_schema_version SMALLINT NOT NULL CHECK (workboard_schema_version = 2),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_id, tab_gid, role),
  UNIQUE (sheet_id, tab_gid, col_index)
);
