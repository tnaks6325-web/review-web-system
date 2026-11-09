-- Purchase photo checks are independent of identity/review/payment approval.
-- Order deletion removes checks/history. C/S deletion only detaches message IDs;
-- existing conversations must never be deleted by deleting a photo check.
CREATE TABLE IF NOT EXISTS purchase_capture_check_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_submission_id uuid NOT NULL REFERENCES order_submissions(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('single','naver','coupang')),
  evidence_hash text NOT NULL CHECK(length(evidence_hash)>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','needs_photo','confirmed')),
  note text NOT NULL DEFAULT '',
  cs_message_id uuid REFERENCES cs_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_submission_id,channel,evidence_hash)
);
CREATE TABLE IF NOT EXISTS purchase_capture_check_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES purchase_capture_check_requests(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('needs_photo','confirmed')),
  note text NOT NULL DEFAULT '',
  actor jsonb NOT NULL,
  cs_message_id uuid REFERENCES cs_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_capture_check_history_request
  ON purchase_capture_check_history(request_id,created_at);
