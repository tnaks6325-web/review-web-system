-- 140: 작업보드 통폐합 운영 안전장치
-- 승인된 기존 작업 120건만 전환하고, 작업별 pilot/전체전환/되돌림 상태를 기록한다.

CREATE TABLE IF NOT EXISTS workboard_consolidation_targets (
  sheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'legacy_120'
    CHECK (source IN ('legacy_120', 'new_work')),
  rollout_state TEXT NOT NULL DEFAULT 'approved'
    CHECK (rollout_state IN ('approved', 'mapped', 'pilot', 'enabled', 'rolled_back')),
  workboard_id UUID REFERENCES workboards(id),
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_id, tab_name)
);

CREATE INDEX IF NOT EXISTS idx_workboard_consolidation_targets_state
  ON workboard_consolidation_targets(source, rollout_state);
CREATE INDEX IF NOT EXISTS idx_workboard_consolidation_targets_workboard
  ON workboard_consolidation_targets(workboard_id)
  WHERE workboard_id IS NOT NULL;

