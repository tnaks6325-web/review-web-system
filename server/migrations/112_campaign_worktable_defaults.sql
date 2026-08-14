-- 무시트 작업표 날짜별 "기본" 인원 스냅샷.
-- 달력 조절이 작업표 행을 이동시킨 뒤에도 [기본으로]가 최초 분배로 돌아갈 기준을 보존한다.
CREATE TABLE IF NOT EXISTS campaign_worktable_defaults (
  campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL,
  default_count INTEGER NOT NULL CHECK (default_count >= 0),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, plan_date)
);
