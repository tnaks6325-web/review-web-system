-- ============================================================
-- 029_raw_sheet_mirror.sql
-- 구글시트 전체 RAW 미러링
--   인덱스(시트DB)로 관리되는 모든 스프레드시트의 "모든 탭 · 모든 행"을
--   구조와 무관하게 SQL로 통째 보존한다.
--     - 리뷰 인덱스로 "인식되지 않는" 탭, 시스템 탭, 숨김 탭까지 포함
--     - 각 행은 cells(JSONB 배열)에 원본 셀 값을 순서 그대로 저장
--   review_index(구조화 데이터)와 독립적으로 동작하는 원본 거울(mirror)이다.
-- ============================================================

-- 1) 미러링된 탭 메타 (탭 1개 = 1행)
CREATE TABLE IF NOT EXISTS raw_sheet_tabs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id          TEXT NOT NULL,
  sheet_url         TEXT,
  spreadsheet_title TEXT,                 -- 구글시트 파일명 (= campaign_name)
  tab_gid           TEXT NOT NULL,        -- 탭 GID (이름 변경에 안전한 식별자)
  tab_name          TEXT NOT NULL,
  row_count         INTEGER DEFAULT 0,    -- 미러링된 데이터 행 수
  col_count         INTEGER DEFAULT 0,    -- 최대 열 수
  headers           JSONB,                -- 첫 행(헤더 후보) 원본 그대로
  is_system_tab     BOOLEAN DEFAULT FALSE,-- 검색인덱스/세부목록 등 시스템 탭 여부(플래그만)
  is_hidden         BOOLEAN DEFAULT FALSE,-- 숨김 탭 여부
  checksum          TEXT,                 -- 증분 미러링용 (변경 없으면 스킵)
  sheet_modified_at TIMESTAMPTZ,          -- Drive 기준 스프레드시트 최종 수정시각
  mirrored_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sheet_id, tab_gid)
);
CREATE INDEX IF NOT EXISTS idx_raw_tabs_sheet ON raw_sheet_tabs(sheet_id);
CREATE INDEX IF NOT EXISTS idx_raw_tabs_name  ON raw_sheet_tabs(tab_name);

-- 2) 미러링된 데이터 (행 1개 = 1행, 셀 값은 JSONB 배열로 보존)
CREATE TABLE IF NOT EXISTS raw_sheet_rows (
  id          BIGSERIAL PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  tab_gid     TEXT NOT NULL,
  tab_name    TEXT NOT NULL,
  row_index   INTEGER NOT NULL,           -- 구글시트 1-based 행 번호
  cells       JSONB NOT NULL,             -- ["값1","값2", ...] 원본 순서 그대로
  mirrored_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sheet_id, tab_gid, row_index)
);
CREATE INDEX IF NOT EXISTS idx_raw_rows_tab ON raw_sheet_rows(sheet_id, tab_gid);
