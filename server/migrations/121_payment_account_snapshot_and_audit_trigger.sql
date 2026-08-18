-- 120은 이미 운영·테스트 DB에 적용될 수 있으므로, 후속 구조는 새 파일에서만 추가한다.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE payment_batch_items
  ADD COLUMN IF NOT EXISTS account_snapshot_fingerprint TEXT;

CREATE OR REPLACE FUNCTION audit_reviewer_account_change()
RETURNS TRIGGER AS $$
DECLARE
  actor TEXT := COALESCE(NULLIF(current_setting('app.changed_by', true), ''), 'reviewer-profile');
  before_sub JSONB;
  after_sub JSONB;
  before_account TEXT;
  after_account TEXT;
  before_bank TEXT;
  after_bank TEXT;
  before_holder TEXT;
  after_holder TEXT;
  phone8 TEXT;
BEGIN
  IF OLD.bank_name IS DISTINCT FROM NEW.bank_name
     OR OLD.bank_account IS DISTINCT FROM NEW.bank_account
     OR OLD.account_holder IS DISTINCT FROM NEW.account_holder THEN
    before_account := regexp_replace(COALESCE(OLD.bank_account, ''), '[^0-9]', '', 'g');
    after_account := regexp_replace(COALESCE(NEW.bank_account, ''), '[^0-9]', '', 'g');
    INSERT INTO reviewer_account_change_audit (
      reviewer_id, before_bank_name, before_account_tail, before_fingerprint,
      after_bank_name, after_account_tail, after_fingerprint, changed_by
    ) VALUES (
      NEW.id, COALESCE(OLD.bank_name, ''), RIGHT(before_account, 4),
      encode(digest(COALESCE(OLD.bank_name, '') || '|' || before_account || '|' || COALESCE(OLD.account_holder, ''), 'sha256'), 'hex'),
      COALESCE(NEW.bank_name, ''), RIGHT(after_account, 4),
      encode(digest(COALESCE(NEW.bank_name, '') || '|' || after_account || '|' || COALESCE(NEW.account_holder, ''), 'sha256'), 'hex'), actor
    );
  END IF;

  FOR before_sub, after_sub IN
    SELECT o.item, n.item
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.sub_accounts) = 'array' THEN OLD.sub_accounts ELSE '[]'::jsonb END) WITH ORDINALITY AS o(item, ordinal)
      FULL OUTER JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.sub_accounts) = 'array' THEN NEW.sub_accounts ELSE '[]'::jsonb END) WITH ORDINALITY AS n(item, ordinal)
        ON COALESCE(NULLIF(RIGHT(regexp_replace(COALESCE(o.item->>'phone', ''), '[^0-9]', '', 'g'), 8), ''), '#' || o.ordinal::text)
         = COALESCE(NULLIF(RIGHT(regexp_replace(COALESCE(n.item->>'phone', ''), '[^0-9]', '', 'g'), 8), ''), '#' || n.ordinal::text)
  LOOP
    before_bank := COALESCE(NULLIF(before_sub->>'bankName', ''), OLD.bank_name, '');
    after_bank := COALESCE(NULLIF(after_sub->>'bankName', ''), NEW.bank_name, '');
    before_account := regexp_replace(COALESCE(NULLIF(before_sub->>'bankAccount', ''), OLD.bank_account, ''), '[^0-9]', '', 'g');
    after_account := regexp_replace(COALESCE(NULLIF(after_sub->>'bankAccount', ''), NEW.bank_account, ''), '[^0-9]', '', 'g');
    before_holder := COALESCE(NULLIF(before_sub->>'accountHolder', ''), OLD.account_holder, '');
    after_holder := COALESCE(NULLIF(after_sub->>'accountHolder', ''), NEW.account_holder, '');
    IF before_bank IS DISTINCT FROM after_bank
       OR before_account IS DISTINCT FROM after_account
       OR before_holder IS DISTINCT FROM after_holder THEN
      phone8 := COALESCE(NULLIF(RIGHT(regexp_replace(COALESCE(after_sub->>'phone', before_sub->>'phone', ''), '[^0-9]', '', 'g'), 8), ''), NULL);
      INSERT INTO reviewer_account_change_audit (
        reviewer_id, sub_phone8, before_bank_name, before_account_tail, before_fingerprint,
        after_bank_name, after_account_tail, after_fingerprint, changed_by
      ) VALUES (
        NEW.id, phone8, before_bank, RIGHT(before_account, 4),
        encode(digest(before_bank || '|' || before_account || '|' || before_holder, 'sha256'), 'hex'),
        after_bank, RIGHT(after_account, 4),
        encode(digest(after_bank || '|' || after_account || '|' || after_holder, 'sha256'), 'hex'), actor
      );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviewer_account_change_audit ON reviewers;
CREATE TRIGGER trg_reviewer_account_change_audit
AFTER UPDATE OF bank_name, bank_account, account_holder, sub_accounts ON reviewers
FOR EACH ROW EXECUTE FUNCTION audit_reviewer_account_change();
