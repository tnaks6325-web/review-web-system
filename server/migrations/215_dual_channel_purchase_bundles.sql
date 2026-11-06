-- 215: additive dual-channel purchase bundle evidence. Legacy rows remain NULL.
BEGIN;
ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS purchase_bundle_version INTEGER,
  ADD COLUMN IF NOT EXISTS purchase_bundle_application_id INTEGER REFERENCES campaign_applications(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purchase_bundle_hash TEXT,
  ADD COLUMN IF NOT EXISTS purchase_condition_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS purchase_identity_result TEXT,
  ADD COLUMN IF NOT EXISTS purchase_identity_review JSONB,
  ADD COLUMN IF NOT EXISTS purchase_bundle_revision INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_purchase_bundle_application
  ON order_submissions(purchase_bundle_application_id) WHERE purchase_bundle_application_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS order_purchase_channels (
  order_submission_id UUID NOT NULL REFERENCES order_submissions(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  order_num TEXT, user_id TEXT, recipient TEXT, phone TEXT, address TEXT,
  paid_amount INTEGER NOT NULL,
  identity_result JSONB,
  PRIMARY KEY(order_submission_id,channel),
  CONSTRAINT ck_order_purchase_channel CHECK(channel IN ('naver','coupang')),
  CONSTRAINT ck_order_purchase_amount CHECK(paid_amount >= 0)
);
CREATE TABLE IF NOT EXISTS purchase_capture_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id INTEGER NOT NULL REFERENCES campaign_applications(id) ON DELETE RESTRICT,
  order_submission_id UUID REFERENCES order_submissions(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL, role TEXT NOT NULL, revision INTEGER NOT NULL,
  file_id TEXT NOT NULL, byte_sha256 TEXT NOT NULL,
  extraction_json JSONB, extraction_proof_hash TEXT NOT NULL,
  final_input_hash TEXT NOT NULL, condition_snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL, superseded_at TIMESTAMPTZ,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_purchase_artifact_revision UNIQUE(application_id,channel,role,revision),
  CONSTRAINT ck_purchase_artifact_channel CHECK(channel IN ('naver','coupang')),
  CONSTRAINT ck_purchase_artifact_role CHECK(role IN ('primary','supplement')),
  CONSTRAINT ck_purchase_artifact_revision CHECK(revision >= 1),
  CONSTRAINT ck_purchase_artifact_status CHECK(status IN ('staged','committed','superseded','abandoned')),
  CONSTRAINT ck_purchase_artifact_hashes CHECK(byte_sha256 ~ '^[0-9a-f]{64}$' AND extraction_proof_hash ~ '^[0-9a-f]{64}$' AND final_input_hash ~ '^[0-9a-f]{64}$' AND condition_snapshot_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_artifact_current ON purchase_capture_artifacts(application_id,channel,role)
  WHERE superseded_at IS NULL AND status IN ('staged','committed');
CREATE INDEX IF NOT EXISTS idx_purchase_artifact_order ON purchase_capture_artifacts(order_submission_id);
CREATE INDEX IF NOT EXISTS idx_purchase_artifact_file ON purchase_capture_artifacts(file_id);
CREATE INDEX IF NOT EXISTS idx_purchase_artifact_sha ON purchase_capture_artifacts(byte_sha256);
ALTER TABLE review_submissions
  ADD COLUMN IF NOT EXISTS order_submission_id UUID REFERENCES order_submissions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purchase_channel TEXT,
  ADD COLUMN IF NOT EXISTS evidence_role TEXT,
  ADD COLUMN IF NOT EXISTS evidence_revision INTEGER,
  ADD COLUMN IF NOT EXISTS byte_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS condition_snapshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
-- Not UNIQUE: a review slot may contain several photos.
CREATE INDEX IF NOT EXISTS idx_review_purchase_current ON review_submissions(order_submission_id,purchase_channel,evidence_role) WHERE superseded_at IS NULL;
ALTER TABLE payment_batch_items
  ADD COLUMN IF NOT EXISTS order_submission_id UUID REFERENCES order_submissions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS eligibility_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_items_active_order ON payment_batch_items(order_submission_id)
  WHERE order_submission_id IS NOT NULL AND status IN ('pending','paid');
DO $guards$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='order_submissions'::regclass AND conname='ck_order_purchase_bundle') THEN
    ALTER TABLE order_submissions ADD CONSTRAINT ck_order_purchase_bundle CHECK (
      (purchase_bundle_version IS NULL AND purchase_bundle_application_id IS NULL AND purchase_bundle_hash IS NULL AND purchase_condition_snapshot IS NULL AND purchase_identity_result IS NULL AND purchase_identity_review IS NULL AND purchase_bundle_revision IS NULL)
      OR
      (purchase_bundle_version IS NOT NULL AND purchase_bundle_version=1 AND purchase_bundle_application_id IS NOT NULL
       AND purchase_bundle_hash IS NOT NULL AND purchase_bundle_hash ~ '^[0-9a-f]{64}$'
       AND purchase_condition_snapshot IS NOT NULL AND jsonb_typeof(purchase_condition_snapshot)='object'
       AND purchase_identity_result IS NOT NULL AND purchase_identity_result IN ('match','uncertain')
       AND purchase_bundle_revision IS NOT NULL AND purchase_bundle_revision>=1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='review_submissions'::regclass AND conname='ck_review_purchase_evidence') THEN
    ALTER TABLE review_submissions ADD CONSTRAINT ck_review_purchase_evidence CHECK (
      (order_submission_id IS NULL AND purchase_channel IS NULL AND evidence_role IS NULL AND evidence_revision IS NULL AND byte_sha256 IS NULL AND condition_snapshot_hash IS NULL AND superseded_at IS NULL)
      OR
      (order_submission_id IS NOT NULL AND purchase_channel IS NOT NULL AND purchase_channel IN ('naver','coupang')
       AND evidence_role IS NOT NULL AND evidence_role IN ('review','receipt') AND evidence_revision IS NOT NULL AND evidence_revision>=1
       AND byte_sha256 IS NOT NULL AND byte_sha256 ~ '^[0-9a-f]{64}$'
       AND condition_snapshot_hash IS NOT NULL AND condition_snapshot_hash ~ '^[0-9a-f]{64}$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='payment_batch_items'::regclass AND conname='ck_payment_purchase_evidence') THEN
    ALTER TABLE payment_batch_items ADD CONSTRAINT ck_payment_purchase_evidence CHECK (
      (order_submission_id IS NULL AND eligibility_fingerprint IS NULL)
      OR (order_submission_id IS NOT NULL AND eligibility_fingerprint IS NOT NULL AND eligibility_fingerprint ~ '^[0-9a-f]{64}$'));
  END IF;
END
$guards$;
COMMIT;
