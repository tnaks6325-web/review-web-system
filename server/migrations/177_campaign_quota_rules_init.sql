-- 177: 인원 규칙 변경 기록 보강 (어제 모집 부족 인원 팝업 — 결정 202)
-- ① 작업 종류(블로그 ↔ 리뷰)가 바뀌어도 어제 정원 의미가 달라진다 → 기록 대상에 넣는다(코덱스 리뷰).
-- ② 배포 당일엔 그 전에 바뀐 규칙을 알 수 없다 → 기존 공고는 이번 배포 시각으로 채운다(첫날은 묻지 않는 쪽으로 — fail-closed).
--    결과: 배포 다음다음 날부터 팝업이 뜬다(어제가 배포 이후가 될 때). 175·176 은 이미 적용된 환경이 있어 고치지 않는다.
CREATE OR REPLACE FUNCTION trg_recruit_campaigns_quota_rules_changed() RETURNS trigger AS $fn$
BEGIN
  IF NEW.daily_limit      IS DISTINCT FROM OLD.daily_limit
  OR NEW.recruit_total    IS DISTINCT FROM OLD.recruit_total
  OR NEW.skip_weekends    IS DISTINCT FROM OLD.skip_weekends
  OR NEW.start_date       IS DISTINCT FROM OLD.start_date
  OR NEW.window_start     IS DISTINCT FROM OLD.window_start
  OR NEW.window_end       IS DISTINCT FROM OLD.window_end
  OR NEW.close_buffer_min IS DISTINCT FROM OLD.close_buffer_min
  OR NEW.carry_strategy   IS DISTINCT FROM OLD.carry_strategy
  OR NEW.carry_mode       IS DISTINCT FROM OLD.carry_mode
  OR NEW.work_kind        IS DISTINCT FROM OLD.work_kind THEN
    NEW.quota_rules_changed_at := NOW();
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

UPDATE recruit_campaigns SET quota_rules_changed_at = NOW() WHERE quota_rules_changed_at IS NULL;
