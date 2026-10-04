-- 176: 인원 규칙 변경 기록에 이월 방식·이월 보류도 넣는다 (어제 모집 부족 인원 팝업 — 결정 202)
-- ★ 이월 방식(다음 날에 더하기·나눠 담기 → 종료일 뒤에 붙이기)이 바뀌면 어제 실제 정원(자동 이월이 얹혔을 수 있다)을
--   지금 설정으로 다시 계산할 수 없다 → 묻지 않게 한다(코덱스 리뷰). 175 는 이미 적용된 환경이 있어 고치지 않고 함수만 바꾼다.
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
  OR NEW.carry_mode       IS DISTINCT FROM OLD.carry_mode THEN
    NEW.quota_rules_changed_at := NOW();
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
