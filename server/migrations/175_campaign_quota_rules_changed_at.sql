-- 175: 공고 인원 규칙이 바뀐 시각 (어제 모집 부족 인원 팝업 — 결정 201)
-- ★ 어제 부족 인원은 공고의 "지금" 설정(일건수·총원·주말·시작일·신청 시간)으로 어제 정원을 다시 계산한다.
--   어제 이후 그 설정이 바뀌었으면 어제 정원을 알 수 없다 → 그 공고는 묻지 않는다(코덱스 리뷰 — 모르면 묻지 않는다).
-- ★ 바꾸는 길이 여러 곳(공고 수정·리뷰어앱 수정·차수 동기화·작업오더 동기화)이라 코드마다 남기면 한 곳은 빠진다
--   → 트리거 한 곳에서 남긴다(값이 실제로 달라졌을 때만). 컬럼 추가 + 트리거만 · 백필 0.
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS quota_rules_changed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION trg_recruit_campaigns_quota_rules_changed() RETURNS trigger AS $fn$
BEGIN
  IF NEW.daily_limit      IS DISTINCT FROM OLD.daily_limit
  OR NEW.recruit_total    IS DISTINCT FROM OLD.recruit_total
  OR NEW.skip_weekends    IS DISTINCT FROM OLD.skip_weekends
  OR NEW.start_date       IS DISTINCT FROM OLD.start_date
  OR NEW.window_start     IS DISTINCT FROM OLD.window_start
  OR NEW.window_end       IS DISTINCT FROM OLD.window_end
  OR NEW.close_buffer_min IS DISTINCT FROM OLD.close_buffer_min THEN
    NEW.quota_rules_changed_at := NOW();
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruit_campaigns_quota_rules_changed ON recruit_campaigns;
CREATE TRIGGER recruit_campaigns_quota_rules_changed
  BEFORE UPDATE ON recruit_campaigns
  FOR EACH ROW EXECUTE FUNCTION trg_recruit_campaigns_quota_rules_changed();
