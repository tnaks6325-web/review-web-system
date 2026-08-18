-- Participation credit type is immutable at application creation time.
ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS is_popular_snapshot BOOLEAN;

-- Preserve the current classification for history created before this column.
UPDATE campaign_applications ca
   SET is_popular_snapshot = rc.is_popular
  FROM recruit_campaigns rc
 WHERE ca.campaign_id = rc.id
   AND ca.is_popular_snapshot IS NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_apps_phone8_popular_credit
  ON campaign_applications (phone8, status, is_popular_snapshot);
