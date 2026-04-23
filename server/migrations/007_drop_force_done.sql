-- Drop force_done column from tab_configs
-- This column was removed as it's a duplicate of is_closed functionality
-- Note: PostgreSQL supports ALTER TABLE ... DROP COLUMN directly

ALTER TABLE tab_configs DROP COLUMN IF EXISTS force_done;
