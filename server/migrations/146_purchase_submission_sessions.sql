-- 구매양식 제출과 구매캡처 업로드를 한 서버 발급 세션으로 결속한다.
-- 토큰 원문은 저장하지 않고 SHA-256 해시만 보관한다.
CREATE TABLE IF NOT EXISTS purchase_submission_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_submission_id  UUID NOT NULL REFERENCES order_submissions(id) ON DELETE CASCADE,
  token_hash           TEXT NOT NULL,
  capture_sheet_id     TEXT NOT NULL DEFAULT '',
  capture_tab_name     TEXT NOT NULL DEFAULT '',
  source               TEXT NOT NULL DEFAULT 'order_submit',
  status               TEXT NOT NULL DEFAULT 'prepared',
  capture_file_id      TEXT,
  failure_code         TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_purchase_submission_sessions_order
  ON purchase_submission_sessions(order_submission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_submission_sessions_expiry
  ON purchase_submission_sessions(expires_at)
  WHERE status IN ('prepared', 'uploading', 'failed');

