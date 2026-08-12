-- Option-specific destination URLs are stored independently from the product main URL.
-- Existing campaigns retain an empty value for backward compatibility.
ALTER TABLE campaign_options
  ADD COLUMN IF NOT EXISTS option_url TEXT NOT NULL DEFAULT '';
