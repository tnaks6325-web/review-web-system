-- 123 의 트리거 함수는 PL/pgSQL 변수 `phone8` 과 서브쿼리 컬럼 별칭 `phone8` 이 겹쳐
-- 실행 시점에 42702(column reference "phone8" is ambiguous)로 죽었다.
-- 트리거는 AFTER UPDATE OF bank_name, bank_account, account_holder, sub_accounts ON reviewers 라
-- 리뷰어 계좌 등록·타계정 저장·구매양식 제출 중 계좌 보강·관리자 계좌 보완이 전부 실패했다.
-- ★ 고치는 것은 이름 충돌뿐 — 감사 대상·조인 키(타계정 phone8 + 같은 번호 내 순번)·기록 값은 123 과 동일하다.
-- ★ 함수 본문은 트리거 생성 시점에 파싱되지 않으므로(마이그레이션은 성공으로 기록된다)
--   이 계열 회귀는 진짜 UPDATE 를 돌려야 잡힌다 — tests/reviewerAccountAuditTrigger.test.js 참조.
CREATE OR REPLACE FUNCTION audit_reviewer_account_change()
RETURNS TRIGGER AS $$
DECLARE
  actor TEXT := COALESCE(NULLIF(current_setting('app.changed_by', true), ''), 'reviewer-profile');
  before_sub JSONB; after_sub JSONB; before_account TEXT; after_account TEXT;
  before_bank TEXT; after_bank TEXT; before_holder TEXT; after_holder TEXT; audit_sub_phone8 TEXT;
BEGIN
  IF OLD.bank_name IS DISTINCT FROM NEW.bank_name OR OLD.bank_account IS DISTINCT FROM NEW.bank_account OR OLD.account_holder IS DISTINCT FROM NEW.account_holder THEN
    before_account := regexp_replace(COALESCE(OLD.bank_account, ''), '[^0-9]', '', 'g');
    after_account := regexp_replace(COALESCE(NEW.bank_account, ''), '[^0-9]', '', 'g');
    INSERT INTO reviewer_account_change_audit (reviewer_id,before_bank_name,before_account_tail,before_fingerprint,after_bank_name,after_account_tail,after_fingerprint,changed_by)
    VALUES (NEW.id,COALESCE(OLD.bank_name,''),RIGHT(before_account,4),encode(digest(COALESCE(OLD.bank_name,'')||'|'||before_account||'|'||COALESCE(OLD.account_holder,''),'sha256'),'hex'),COALESCE(NEW.bank_name,''),RIGHT(after_account,4),encode(digest(COALESCE(NEW.bank_name,'')||'|'||after_account||'|'||COALESCE(NEW.account_holder,''),'sha256'),'hex'),actor);
  END IF;
  FOR before_sub, after_sub IN
    WITH old_rows AS (
      SELECT item, sub_p8, row_number() OVER (PARTITION BY sub_p8 ORDER BY ordinal) AS occurrence
      FROM (SELECT item, ordinal, RIGHT(regexp_replace(COALESCE(item->>'phone',''),'[^0-9]','','g'),8) AS sub_p8 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.sub_accounts)='array' THEN OLD.sub_accounts ELSE '[]'::jsonb END) WITH ORDINALITY AS x(item,ordinal)) s
    ), new_rows AS (
      SELECT item, sub_p8, row_number() OVER (PARTITION BY sub_p8 ORDER BY ordinal) AS occurrence
      FROM (SELECT item, ordinal, RIGHT(regexp_replace(COALESCE(item->>'phone',''),'[^0-9]','','g'),8) AS sub_p8 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.sub_accounts)='array' THEN NEW.sub_accounts ELSE '[]'::jsonb END) WITH ORDINALITY AS x(item,ordinal)) s
    ) SELECT o.item, n.item FROM old_rows o FULL OUTER JOIN new_rows n ON o.sub_p8=n.sub_p8 AND o.occurrence=n.occurrence
  LOOP
    before_bank := CASE WHEN before_sub IS NULL THEN '' ELSE COALESCE(NULLIF(before_sub->>'bankName',''),OLD.bank_name,'') END; after_bank := CASE WHEN after_sub IS NULL THEN '' ELSE COALESCE(NULLIF(after_sub->>'bankName',''),NEW.bank_name,'') END;
    before_account := CASE WHEN before_sub IS NULL THEN '' ELSE regexp_replace(COALESCE(NULLIF(before_sub->>'bankAccount',''),OLD.bank_account,''),'[^0-9]','','g') END; after_account := CASE WHEN after_sub IS NULL THEN '' ELSE regexp_replace(COALESCE(NULLIF(after_sub->>'bankAccount',''),NEW.bank_account,''),'[^0-9]','','g') END;
    before_holder := CASE WHEN before_sub IS NULL THEN '' ELSE COALESCE(NULLIF(before_sub->>'accountHolder',''),OLD.account_holder,'') END; after_holder := CASE WHEN after_sub IS NULL THEN '' ELSE COALESCE(NULLIF(after_sub->>'accountHolder',''),NEW.account_holder,'') END;
    IF before_bank IS DISTINCT FROM after_bank OR before_account IS DISTINCT FROM after_account OR before_holder IS DISTINCT FROM after_holder THEN
      audit_sub_phone8 := NULLIF(RIGHT(regexp_replace(COALESCE(after_sub->>'phone',before_sub->>'phone',''),'[^0-9]','','g'),8),'');
      INSERT INTO reviewer_account_change_audit (reviewer_id,sub_phone8,before_bank_name,before_account_tail,before_fingerprint,after_bank_name,after_account_tail,after_fingerprint,changed_by)
      VALUES (NEW.id,audit_sub_phone8,before_bank,RIGHT(before_account,4),encode(digest(before_bank||'|'||before_account||'|'||before_holder,'sha256'),'hex'),after_bank,RIGHT(after_account,4),encode(digest(after_bank||'|'||after_account||'|'||after_holder,'sha256'),'hex'),actor);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviewer_account_change_audit ON reviewers;
CREATE TRIGGER trg_reviewer_account_change_audit
AFTER UPDATE OF bank_name, bank_account, account_holder, sub_accounts ON reviewers
FOR EACH ROW EXECUTE FUNCTION audit_reviewer_account_change();
