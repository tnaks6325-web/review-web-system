CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS unconfirmed_transfer_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  upload_id UUID NOT NULL REFERENCES payment_result_uploads(id) ON DELETE CASCADE,
  result_seq INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  sheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  participant_row_index INTEGER,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'DUPLICATE_CASE_OPENED')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (upload_id, result_seq)
);

CREATE INDEX IF NOT EXISTS idx_unconfirmed_transfer_reviews_batch_id
  ON unconfirmed_transfer_reviews(batch_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS duplicate_payment_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL UNIQUE REFERENCES unconfirmed_transfer_reviews(id) ON DELETE CASCADE,
  case_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (case_status IN ('PENDING', 'RECOVERY_REQUESTED', 'REFUND_REQUESTED', 'RECOVERED', 'REFUNDED', 'CLOSED')),
  owner_name TEXT NOT NULL DEFAULT '',
  due_at DATE,
  resolution_type TEXT NOT NULL DEFAULT 'RECOVERY'
    CHECK (resolution_type IN ('RECOVERY', 'REFUND')),
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_duplicate_payment_cases_status
  ON duplicate_payment_cases(case_status, due_at);

CREATE TABLE IF NOT EXISTS duplicate_payment_case_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES duplicate_payment_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'UPDATED')),
  before_status TEXT,
  after_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
