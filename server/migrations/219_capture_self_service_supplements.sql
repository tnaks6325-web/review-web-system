-- Append-only C/S evidence. Never participates in the original payout evidence hash.
-- Keep file_id references in image allowlist, deletion tombstones and orphan exclusion lists.
CREATE TABLE IF NOT EXISTS purchase_capture_supplements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 order_submission_id UUID NOT NULL REFERENCES order_submissions(id) ON DELETE CASCADE,
 channel TEXT NOT NULL CHECK(channel IN ('single','naver','coupang')),
 file_id TEXT NOT NULL UNIQUE CHECK(length(btrim(file_id)) > 0),
 byte_sha256 TEXT NOT NULL CHECK(byte_sha256 ~ '^[a-f0-9]{64}$'),
 mime_type TEXT NOT NULL,
 request_key UUID NOT NULL,
 check_request_id UUID, -- migration 220 is installed afterwards; no cross-migration FK
 request_payload_hash TEXT NOT NULL CHECK(request_payload_hash ~ '^[a-f0-9]{64}$'),
 created_by UUID NOT NULL REFERENCES reviewers(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(order_submission_id,channel,request_key)
);
CREATE INDEX IF NOT EXISTS purchase_capture_supplements_order_channel
 ON purchase_capture_supplements(order_submission_id,channel,created_at,id);
