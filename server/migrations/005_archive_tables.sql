-- ═══════════════════════════════════════════════════════════
-- 005: 완료 캠페인 아카이브 테이블 + 관련 인덱스
-- 목적: 완료된 캠페인의 인덱스 데이터를 별도 테이블로 이동하여
--       활성 데이터 로딩 속도 향상 + 데이터 관리 편의성 확보
-- ═══════════════════════════════════════════════════════════

-- 1. 아카이브된 인덱스 마스터 (index_master 와 동일 구조 + 아카이브 메타)
CREATE TABLE IF NOT EXISTS index_master_archive (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  tab_gid         TEXT,
  campaign_name   TEXT,
  row_count       INTEGER,
  submitted_count INTEGER,
  last_date       TEXT,
  checksum        TEXT,
  built_at        TIMESTAMPTZ,
  status          TEXT DEFAULT 'archived',
  skip_reason     TEXT,
  error_msg       TEXT,
  sheet_modified_at TIMESTAMPTZ,
  -- 아카이브 메타 정보
  archived_at     TIMESTAMPTZ DEFAULT NOW(),
  archived_by     TEXT,               -- 아카이브 실행한 관리자
  archive_reason  TEXT DEFAULT 'completed', -- completed | manual | bulk
  UNIQUE(sheet_id, tab_name)
);

-- 2. 아카이브된 리뷰 인덱스 (review_index 와 동일 구조 + 아카이브 메타)
CREATE TABLE IF NOT EXISTS review_index_archive (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_name   TEXT NOT NULL,
  sheet_id        TEXT NOT NULL,
  tab_gid         TEXT,
  tab_name        TEXT NOT NULL,
  campaign_name   TEXT,
  row_index       INTEGER,
  is_submitted    BOOLEAN DEFAULT FALSE,
  is_submitted2   TEXT DEFAULT 'NONE',
  product_url     TEXT,
  product_name    TEXT,
  submit_col      TEXT,
  submit_col2     TEXT,
  row_json        JSONB,
  start_date      TEXT,
  end_date        TEXT,
  round           TEXT,
  phone8          TEXT,
  built_at        TIMESTAMPTZ DEFAULT NOW(),
  -- 아카이브 메타
  archived_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 아카이브 이력 테이블 (아카이브/복원 이력 추적)
CREATE TABLE IF NOT EXISTS archive_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action          TEXT NOT NULL,       -- 'archive' | 'restore'
  sheet_id        TEXT NOT NULL,
  campaign_name   TEXT,
  tab_count       INTEGER DEFAULT 0,
  row_count       INTEGER DEFAULT 0,
  performed_by    TEXT,
  performed_at    TIMESTAMPTZ DEFAULT NOW(),
  note            TEXT
);

-- 4. 인덱스 (아카이브 조회 성능)
CREATE INDEX IF NOT EXISTS idx_archive_master_sheet ON index_master_archive(sheet_id);
CREATE INDEX IF NOT EXISTS idx_archive_master_campaign ON index_master_archive(campaign_name);
CREATE INDEX IF NOT EXISTS idx_archive_review_sheet_tab ON review_index_archive(sheet_id, tab_name);
CREATE INDEX IF NOT EXISTS idx_archive_review_name ON review_index_archive(reviewer_name);
CREATE INDEX IF NOT EXISTS idx_archive_history_sheet ON archive_history(sheet_id);
CREATE INDEX IF NOT EXISTS idx_archive_history_date ON archive_history(performed_at DESC);
