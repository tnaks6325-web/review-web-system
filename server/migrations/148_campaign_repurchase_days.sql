-- 148: 모집공고별 재참여(재구매) 제한 기간.
-- 0은 제한 없음, 1~365는 구매양식 제출 시각부터 차단할 일수다.
-- 기존 공고(NULL)는 배포 전부터 쓰던 CAMPAIGN_REPARTICIPATE_DAYS 값을 상속한다.
-- 새 공고는 서버가 명시값을 저장하며, DB 기본값 14는 비정상/직접 INSERT의 안전망이다.

ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS repurchase_days INTEGER;

-- 중간 실패 뒤 재실행되거나 컬럼만 먼저 만들어진 환경도 같은 계약으로 수렴시킨다.
ALTER TABLE recruit_campaigns
  ALTER COLUMN repurchase_days SET DEFAULT 14;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'recruit_campaigns_repurchase_days_check'
       AND conrelid = 'recruit_campaigns'::regclass
  ) THEN
    ALTER TABLE recruit_campaigns
      ADD CONSTRAINT recruit_campaigns_repurchase_days_check
      CHECK (repurchase_days IS NULL OR repurchase_days BETWEEN 0 AND 365) NOT VALID;
  END IF;
END
$$;

ALTER TABLE recruit_campaigns
  VALIDATE CONSTRAINT recruit_campaigns_repurchase_days_check;

COMMENT ON COLUMN recruit_campaigns.repurchase_days IS
  'Campaign-specific repurchase restriction in days. NULL inherits the legacy environment default; 0 disables the restriction; valid range 0..365.';
