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

-- 계좌 수정 경로가 늘어나더라도 감사 누락이 생기지 않도록 DB에서 일괄 기록한다.
-- 애플리케이션은 트랜잭션 안에서 app.changed_by를 설정할 수 있고, 설정하지 않은
-- 등록리뷰어DB 수정도 reviewer-profile로 남겨 추적 가능하게 한다.
CREATE OR REPLACE FUNCTION audit_reviewer_account_change()
RETURNS TRIGGER AS $$
DECLARE
  actor TEXT := COALESCE(NULLIF(current_setting('app.changed_by', true), ''), 'reviewer-profile');
BEGIN
  IF OLD.bank_name IS DISTINCT FROM NEW.bank_name
     OR OLD.bank_account IS DISTINCT FROM NEW.bank_account
     OR OLD.account_holder IS DISTINCT FROM NEW.account_holder THEN
    INSERT INTO reviewer_account_change_audit (
      reviewer_id, before_bank_name, before_account_tail, before_fingerprint,
      after_bank_name, after_account_tail, after_fingerprint, changed_by
    ) VALUES (
      NEW.id,
      COALESCE(OLD.bank_name, ''), RIGHT(regexp_replace(COALESCE(OLD.bank_account, ''), '\\D', '', 'g'), 4),
      encode(digest(COALESCE(OLD.bank_name, '') || E'\\000' || regexp_replace(COALESCE(OLD.bank_account, ''), '\\D', '', 'g') || E'\\000' || COALESCE(OLD.account_holder, ''), 'sha256'), 'hex'),
      COALESCE(NEW.bank_name, ''), RIGHT(regexp_replace(COALESCE(NEW.bank_account, ''), '\\D', '', 'g'), 4),
      encode(digest(COALESCE(NEW.bank_name, '') || E'\\000' || regexp_replace(COALESCE(NEW.bank_account, ''), '\\D', '', 'g') || E'\\000' || COALESCE(NEW.account_holder, ''), 'sha256'), 'hex'),
      actor
    );
  END IF;

  IF OLD.sub_accounts IS DISTINCT FROM NEW.sub_accounts THEN
    INSERT INTO reviewer_account_change_audit (
      reviewer_id, before_fingerprint, after_fingerprint, changed_by
    ) VALUES (
      NEW.id,
      encode(digest(COALESCE(OLD.sub_accounts::text, ''), 'sha256'), 'hex'),
      encode(digest(COALESCE(NEW.sub_accounts::text, ''), 'sha256'), 'hex'),
      actor
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviewer_account_change_audit ON reviewers;
CREATE TRIGGER trg_reviewer_account_change_audit
AFTER UPDATE OF bank_name, bank_account, account_holder, sub_accounts ON reviewers
FOR EACH ROW EXECUTE FUNCTION audit_reviewer_account_change();
