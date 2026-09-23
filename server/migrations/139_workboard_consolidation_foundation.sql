-- 139: 작업표/작업보드 통폐합 0단계 — 가산적 식별자 + 롤백 스냅샷 장치
--
-- 이 마이그레이션은 기존 데이터의 값을 바꾸지 않는다. 실제 전환 전에 대상별 스냅샷을
-- 남기고, 새 경로는 기본값 legacy(비활성)에서만 명시적으로 열 수 있다.

CREATE TABLE IF NOT EXISTS workboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  schema_version SMALLINT NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS workboard_id UUID REFERENCES workboards(id);
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS workboard_id UUID REFERENCES workboards(id);
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS workboard_id UUID REFERENCES workboards(id);
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS workboard_id UUID REFERENCES workboards(id);
ALTER TABLE campaign_participants ADD COLUMN IF NOT EXISTS workboard_id UUID REFERENCES workboards(id);

CREATE INDEX IF NOT EXISTS idx_work_orders_workboard_id ON work_orders(workboard_id) WHERE workboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recruit_campaigns_workboard_id ON recruit_campaigns(workboard_id) WHERE workboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tab_configs_workboard_id ON tab_configs(workboard_id) WHERE workboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_submissions_workboard_id ON order_submissions(workboard_id) WHERE workboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_participants_workboard_id ON campaign_participants(workboard_id) WHERE workboard_id IS NOT NULL;

-- 대상 작업별 전환 직전 스냅샷. 레코드는 JSONB 원문으로 보관해 스키마 확장 중에도
-- 당시 값을 잃지 않는다. 실제 전환은 이 백업이 sealed 상태일 때만 허용한다.
CREATE TABLE IF NOT EXISTS workboard_consolidation_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  targets JSONB NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'sealed' CHECK (state IN ('sealed', 'superseded')),
  record_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  checksum TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workboard_consolidation_backup_records (
  backup_id UUID NOT NULL REFERENCES workboard_consolidation_backups(id) ON DELETE CASCADE,
  ordinal BIGSERIAL NOT NULL,
  table_name TEXT NOT NULL,
  row_data JSONB NOT NULL,
  PRIMARY KEY (backup_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_workboard_consolidation_backup_records
  ON workboard_consolidation_backup_records(backup_id, table_name);

-- 가산적 연결의 변경 저널. 이 행이 있는 경우에만 workboard_id를 비우는 롤백을 허용한다.
-- 따라서 이전부터 존재하던 연결을 롤백 과정에서 지우지 않는다.
CREATE TABLE IF NOT EXISTS workboard_consolidation_link_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id UUID NOT NULL REFERENCES workboard_consolidation_backups(id),
  sheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  workboard_id UUID NOT NULL REFERENCES workboards(id),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at TIMESTAMPTZ,
  reverted_by TEXT,
  UNIQUE(backup_id, sheet_id, tab_name)
);
CREATE INDEX IF NOT EXISTS idx_workboard_consolidation_link_events_active
  ON workboard_consolidation_link_events(backup_id)
  WHERE reverted_at IS NULL;

-- 전환 모드의 단일 출처. 배포 직후 legacy이므로 기존 시트/무시트 경로 모두 불변이다.
CREATE TABLE IF NOT EXISTS workboard_consolidation_controls (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'pilot', 'enabled')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT '',
  rollback_backup_id UUID REFERENCES workboard_consolidation_backups(id)
);
INSERT INTO workboard_consolidation_controls(singleton, mode, updated_by)
VALUES (TRUE, 'legacy', 'migration-139')
ON CONFLICT (singleton) DO NOTHING;
