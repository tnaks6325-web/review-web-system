-- Intranet review-order purchase channel is authoritative. Keep it on the
-- work order so recruitment-post prefill does not have to guess from a URL.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS purchase_channel TEXT DEFAULT '';
