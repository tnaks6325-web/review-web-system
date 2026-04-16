-- ============================================================
-- 리뷰웹시스템 PostgreSQL 스키마 v2.0
-- Phase B: 완전 구현 — 모든 GAS 기능 대응
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
CREATE INDEX IF NOT EXISTS idx_tab_configs_campaign ON tab_configs(campaign_name);

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
  phone8         TEXT,
  built_at       TIMESTAMPTZ DEFAULT NOW(),
  name_search    TSVECTOR GENERATED ALWAYS AS
                   (to_tsvector('simple', COALESCE(reviewer_name, ''))) STORED
);
CREATE INDEX IF NOT EXISTS idx_review_name_fts  ON review_index USING GIN(name_search);
CREATE INDEX IF NOT EXISTS idx_review_name_like ON review_index(reviewer_name);
CREATE INDEX IF NOT EXISTS idx_review_sheet     ON review_index(sheet_id, tab_name);
CREATE INDEX IF NOT EXISTS idx_review_submitted ON review_index(is_submitted);
CREATE INDEX IF NOT EXISTS idx_review_phone8    ON review_index(phone8);

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
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 영업담당자(Staff) 계정 — GAS STAFF_USERS_V1 대체
CREATE TABLE IF NOT EXISTS staff_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username   TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. 메모
CREATE TABLE IF NOT EXISTS memos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_key    TEXT NOT NULL UNIQUE,
  role       TEXT,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. 단축 URL
CREATE TABLE IF NOT EXISTS short_links (
  code         TEXT PRIMARY KEY,
  sheet_id     TEXT,
  gid          TEXT,
  tab_name     TEXT,
  display_name TEXT,
  option_list  JSONB,
  composite_key TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_short_composite ON short_links(composite_key);

-- 10. 블랙리스트
CREATE TABLE IF NOT EXISTS blacklist (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone     TEXT NOT NULL UNIQUE,
  name      TEXT,
  reason    TEXT,
  added_by  TEXT,
  added_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 11. 입금처리 이력
CREATE TABLE IF NOT EXISTS payment_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id       TEXT NOT NULL,
  tab_name       TEXT NOT NULL,
  reviewer_name  TEXT NOT NULL,
  row_index      INTEGER,
  amount         TEXT,
  status         TEXT DEFAULT 'paid',
  paid_by        TEXT,
  paid_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_tab ON payment_records(sheet_id, tab_name);

-- 12. 구매양식 주문 제출 이력 (중복 검사용)
CREATE TABLE IF NOT EXISTS order_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id         TEXT NOT NULL,
  tab_name         TEXT NOT NULL,
  gid              TEXT,
  orderer          TEXT,
  recipient        TEXT,
  user_id          TEXT,
  phone            TEXT,
  address          TEXT,
  order_num        TEXT,
  date_str         TEXT,
  selected_opt_key TEXT,
  submitted_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_sheet_tab ON order_submissions(sheet_id, tab_name);
CREATE INDEX IF NOT EXISTS idx_order_user ON order_submissions(user_id);

-- 13. 빌드 잠금 (GAS LockService + PropertiesService 대체)
CREATE TABLE IF NOT EXISTS build_locks (
  lock_key    TEXT PRIMARY KEY DEFAULT 'INDEX_BUILD',
  locked_at   TIMESTAMPTZ,
  locked_by   TEXT,
  is_locked   BOOLEAN DEFAULT FALSE
);
-- 초기 잠금 행 삽입
INSERT INTO build_locks (lock_key, is_locked) VALUES ('INDEX_BUILD', FALSE) ON CONFLICT DO NOTHING;

-- 14. 앱 설정 (GAS PropertiesService 대체)
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
