-- 104: A campaign inherits the ReviewOrder weekend rule at publication time.
-- Cards remain visible on Saturday/Sunday, while the application write path
-- blocks with a deterministic "weekend unpublished" response.
ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS skip_weekends BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_recruit_campaigns_skip_weekends
  ON recruit_campaigns (skip_weekends)
  WHERE skip_weekends = TRUE;
