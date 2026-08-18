-- 회차 생성 당시의 계좌 출처를 남기고, 계좌 수정은 마스킹 값·지문으로 감사한다.
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS account_reviewer_id UUID;
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS account_source TEXT CHECK (account_source IN ('self', 'sub'));
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS account_sub_phone8 TEXT;
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS account_fingerprint TEXT;
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS account_snapshot_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS reviewer_account_change_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE RESTRICT,
  sub_phone8 TEXT,
  before_bank_name TEXT NOT NULL DEFAULT '',
  before_account_tail TEXT NOT NULL DEFAULT '',
  before_fingerprint TEXT NOT NULL DEFAULT '',
  after_bank_name TEXT NOT NULL DEFAULT '',
  after_account_tail TEXT NOT NULL DEFAULT '',
  after_fingerprint TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviewer_account_change_audit_reviewer ON reviewer_account_change_audit(reviewer_id, changed_at DESC);
