-- 타계정 배열의 삽입·삭제에도 감사 대상이 바뀌지 않게 안정 식별자로 트리거를 교체한다.
CREATE OR REPLACE FUNCTION audit_reviewer_account_change()
RETURNS TRIGGER AS $$
DECLARE
  actor TEXT := COALESCE(NULLIF(current_setting('app.changed_by', true), ''), 'reviewer-profile');
  before_sub JSONB; after_sub JSONB; before_account TEXT; after_account TEXT;
  before_bank TEXT; after_bank TEXT; before_holder TEXT; after_holder TEXT; phone8 TEXT;
BEGIN
  IF OLD.bank_name IS DISTINCT FROM NEW.bank_name OR OLD.bank_account IS DISTINCT FROM NEW.bank_account OR OLD.account_holder IS DISTINCT FROM NEW.account_holder THEN
    before_account := regexp_replace(COALESCE(OLD.bank_account, ''), '[^0-9]', '', 'g');
    after_account := regexp_replace(COALESCE(NEW.bank_account, ''), '[^0-9]', '', 'g');
    INSERT INTO reviewer_account_change_audit (reviewer_id,before_bank_name,before_account_tail,before_fingerprint,after_bank_name,after_account_tail,after_fingerprint,changed_by)
    VALUES (NEW.id,COALESCE(OLD.bank_name,''),RIGHT(before_account,4),encode(digest(COALESCE(OLD.bank_name,'')||'|'||before_account||'|'||COALESCE(OLD.account_holder,''),'sha256'),'hex'),COALESCE(NEW.bank_name,''),RIGHT(after_account,4),encode(digest(COALESCE(NEW.bank_name,'')||'|'||after_account||'|'||COALESCE(NEW.account_holder,''),'sha256'),'hex'),actor);
  END IF;
  FOR before_sub, after_sub IN
    WITH old_rows AS (
      SELECT item, phone8, row_number() OVER (PARTITION BY phone8 ORDER BY ordinal) AS occurrence
      FROM (SELECT item, ordinal, RIGHT(regexp_replace(COALESCE(item->>'phone',''),'[^0-9]','','g'),8) AS phone8 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.sub_accounts)='array' THEN OLD.sub_accounts ELSE '[]'::jsonb END) WITH ORDINALITY AS x(item,ordinal)) s
    ), new_rows AS (
      SELECT item, phone8, row_number() OVER (PARTITION BY phone8 ORDER BY ordinal) AS occurrence
      FROM (SELECT item, ordinal, RIGHT(regexp_replace(COALESCE(item->>'phone',''),'[^0-9]','','g'),8) AS phone8 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.sub_accounts)='array' THEN NEW.sub_accounts ELSE '[]'::jsonb END) WITH ORDINALITY AS x(item,ordinal)) s
    ) SELECT o.item, n.item FROM old_rows o FULL OUTER JOIN new_rows n ON o.phone8=n.phone8 AND o.occurrence=n.occurrence
  LOOP
    before_bank := CASE WHEN before_sub IS NULL THEN '' ELSE COALESCE(NULLIF(before_sub->>'bankName',''),OLD.bank_name,'') END; after_bank := CASE WHEN after_sub IS NULL THEN '' ELSE COALESCE(NULLIF(after_sub->>'bankName',''),NEW.bank_name,'') END;
    before_account := CASE WHEN before_sub IS NULL THEN '' ELSE regexp_replace(COALESCE(NULLIF(before_sub->>'bankAccount',''),OLD.bank_account,''),'[^0-9]','','g') END; after_account := CASE WHEN after_sub IS NULL THEN '' ELSE regexp_replace(COALESCE(NULLIF(after_sub->>'bankAccount',''),NEW.bank_account,''),'[^0-9]','','g') END;
    before_holder := CASE WHEN before_sub IS NULL THEN '' ELSE COALESCE(NULLIF(before_sub->>'accountHolder',''),OLD.account_holder,'') END; after_holder := CASE WHEN after_sub IS NULL THEN '' ELSE COALESCE(NULLIF(after_sub->>'accountHolder',''),NEW.account_holder,'') END;
    IF before_bank IS DISTINCT FROM after_bank OR before_account IS DISTINCT FROM after_account OR before_holder IS DISTINCT FROM after_holder THEN
      phone8 := NULLIF(RIGHT(regexp_replace(COALESCE(after_sub->>'phone',before_sub->>'phone',''),'[^0-9]','','g'),8),'');
      INSERT INTO reviewer_account_change_audit (reviewer_id,sub_phone8,before_bank_name,before_account_tail,before_fingerprint,after_bank_name,after_account_tail,after_fingerprint,changed_by)
      VALUES (NEW.id,phone8,before_bank,RIGHT(before_account,4),encode(digest(before_bank||'|'||before_account||'|'||before_holder,'sha256'),'hex'),after_bank,RIGHT(after_account,4),encode(digest(after_bank||'|'||after_account||'|'||after_holder,'sha256'),'hex'),actor);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
