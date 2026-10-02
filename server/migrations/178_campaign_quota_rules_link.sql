-- 178: 연결 작업표가 바뀌어도 규칙 변경으로 기록 (어제 모집 부족 인원 팝업 — 결정 201)
-- ★ 연결 탭을 바꾸면 어제·오늘 두 시점 모두 새 탭의 주문을 세서, 옛 탭에 들어온 어제 주문이 사라진다
--   → 어제 수를 알 수 없다 → 묻지 않게 기록한다(코덱스 리뷰). 175~177 은 이미 적용된 환경이 있어 함수만 바꾼다.
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
  OR NEW.work_kind        IS DISTINCT FROM OLD.work_kind
  OR NEW.linked_sheet_id  IS DISTINCT FROM OLD.linked_sheet_id
  OR NEW.linked_tab_name  IS DISTINCT FROM OLD.linked_tab_name
  OR NEW.linked_tab_gid   IS DISTINCT FROM OLD.linked_tab_gid THEN
    NEW.quota_rules_changed_at := NOW();
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
