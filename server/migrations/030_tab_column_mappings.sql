-- ============================================================
-- 030_tab_column_mappings.sql
-- 명시적 컬럼 매핑 레이어 (점진적 구글시트 대체의 keystone)
--   탭(시트의 한 탭)마다 "시트의 실제 열 ↔ DB 표준필드"를 명시적으로 저장한다.
--   - db_field : 표준 필드 키 (NULL = 미매핑)
--   - owner    : 열 소유권 — 'db'(DB권위) | 'sheet'(시트권위) | 'shared'(공용)
--     → 양방향 동기화 충돌을 "누가 주인인가"로 원천 차단하기 위한 기준
--   - header_text : 매핑 저장 시점의 헤더 문자열 (헤더 변경=드리프트 감지용)
-- 이 테이블은 자동 추측(키워드)으로 초안을 만들고 사람이 교정하는 용도이며,
-- 아직 어떤 쓰기 로직도 바꾸지 않는다(2a 단계: 정의/열람/편집만).
-- ============================================================

CREATE TABLE IF NOT EXISTS tab_column_mappings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id    TEXT NOT NULL,
  tab_gid     TEXT NOT NULL,
  tab_name    TEXT,
  col_index   INTEGER NOT NULL,                 -- 0-based 시트 열 위치
  header_text TEXT,                             -- 저장 시점 헤더 문자열
  db_field    TEXT,                             -- 표준 필드 키 (NULL=미매핑)
  owner       TEXT NOT NULL DEFAULT 'sheet',    -- 'db' | 'sheet' | 'shared'
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  TEXT,
  UNIQUE(sheet_id, tab_gid, col_index)
);
CREATE INDEX IF NOT EXISTS idx_tab_col_map_tab   ON tab_column_mappings(sheet_id, tab_gid);
CREATE INDEX IF NOT EXISTS idx_tab_col_map_field ON tab_column_mappings(db_field);
