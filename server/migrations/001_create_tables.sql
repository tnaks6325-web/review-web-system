-- ============================================================
-- 리뷰웹시스템 PostgreSQL 스키마 v1.0
-- ============================================================

-- 1. 캠페인(베이스시트 내 시트 목록)
CREATE TABLE IF NOT EXISTS campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id      TEXT NOT NULL,
  sheet_url     TEXT,
  campaign_name TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sheet_id, campaign_name)
);

-- 2. 탭별 설정 (현재 세부목록 탭 대체)
CREATE TABLE IF NOT EXISTS tab_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id         TEXT NOT NULL,
  tab_name         TEXT NOT NULL,
  sheet_url        TEXT,
  manager          TEXT,
  time_range       TEXT,
  taekhap          BOOLEAN DEFAULT FALSE,
  review_type      TEXT,
  payment_type     TEXT,
  display_name     TEXT,
  force_done       BOOLEAN DEFAULT FALSE,
  is_closed        BOOLEAN DEFAULT FALSE,
  folder_url       TEXT,
  capture_folder_url TEXT,
  is_bulk          BOOLEAN DEFAULT FALSE,
  delivery_type    TEXT,
  round            TEXT,
  nc_mode          BOOLEAN DEFAULT FALSE,
  deposit_name     TEXT,
  transfer_bank    TEXT,
  income_type      TEXT,
  campaign_name    TEXT,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sheet_id, tab_name)
);

-- 3. 검색 인덱스 (검색인덱스 탭 대체)
CREATE TABLE IF NOT EXISTS review_index (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_name  TEXT NOT NULL,
  sheet_id       TEXT NOT NULL,
  tab_gid        TEXT,
  tab_name       TEXT NOT NULL,
  campaign_name  TEXT,
  row_index      INTEGER,
  is_submitted   BOOLEAN DEFAULT FALSE,
  is_submitted2  TEXT DEFAULT 'NONE',
  product_url    TEXT,
  product_name   TEXT,
  submit_col     TEXT,
  submit_col2    TEXT,
  row_json       JSONB,
  start_date     TEXT,
  end_date       TEXT,
  round          TEXT,
  built_at       TIMESTAMPTZ DEFAULT NOW(),
  name_search    TSVECTOR GENERATED ALWAYS AS
                   (to_tsvector('simple', COALESCE(reviewer_name, ''))) STORED
);
CREATE INDEX IF NOT EXISTS idx_review_name_fts  ON review_index USING GIN(name_search);
CREATE INDEX IF NOT EXISTS idx_review_name_like ON review_index(reviewer_name);
CREATE INDEX IF NOT EXISTS idx_review_sheet     ON review_index(sheet_id, tab_name);
CREATE INDEX IF NOT EXISTS idx_review_submitted ON review_index(is_submitted);

-- 4. 인덱스 마스터 (체크섬 기반 증분빌드 메타)
CREATE TABLE IF NOT EXISTS index_master (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  tab_gid         TEXT,
  campaign_name   TEXT,
  row_count       INTEGER DEFAULT 0,
  submitted_count INTEGER DEFAULT 0,
  last_date       TEXT,
  checksum        TEXT,
  built_at        TIMESTAMPTZ,
  status          TEXT DEFAULT 'active',
  skip_reason     TEXT,
  error_msg       TEXT,
  UNIQUE(sheet_id, tab_name)
);

-- 5. 리뷰어 회원 (인애드명단 시트 대체)
CREATE TABLE IF NOT EXISTS reviewers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  phone8        TEXT GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'), 8)) STORED,
  consent       BOOLEAN DEFAULT TRUE,
  status        TEXT DEFAULT 'active',
  income_type   TEXT,
  resident_num  TEXT,
  sub_accounts  JSONB DEFAULT '[]',
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(phone)
);
CREATE INDEX IF NOT EXISTS idx_reviewers_phone8 ON reviewers(phone8);
CREATE INDEX IF NOT EXISTS idx_reviewers_name   ON reviewers(name);

-- 6. 관리자 계정
CREATE TABLE IF NOT EXISTS admin_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username   TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  role       TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 메모
CREATE TABLE IF NOT EXISTS memos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_key    TEXT NOT NULL UNIQUE,
  role       TEXT,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. 단축 URL
CREATE TABLE IF NOT EXISTS short_links (
  code         TEXT PRIMARY KEY,
  sheet_id     TEXT,
  gid          TEXT,
  tab_name     TEXT,
  display_name TEXT,
  option_list  JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 9. 블랙리스트
CREATE TABLE IF NOT EXISTS blacklist (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone     TEXT NOT NULL UNIQUE,
  name      TEXT,
  reason    TEXT,
  added_by  TEXT,
  added_at  TIMESTAMPTZ DEFAULT NOW()
);
