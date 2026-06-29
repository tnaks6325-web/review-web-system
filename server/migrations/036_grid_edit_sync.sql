-- 036: DB-primary 그리드 편집 + 양방향 동기화 (Phase 1, 값 전용)
-- Idempotent, additive. 기존 RAW 미러 데이터/주문 원장은 보존된다.
--
-- 목적:
--  - raw_sheet_rows 를 편집 소스로 사용. 셀 편집 시 dirty 플래그 → 큐(cell_write)로 시트 반영.
--  - dirty 행이 남은 탭은 RAW 미러가 skip(아웃바운드 쓰기 우선) → 시트 옛 값으로 덮어쓰기 방지.
--  - grid_edit_log: 운영/롤백용 값-편집 감사 로그(정확성에는 불필요, 가시성/추적용).

-- ── per-row 아웃바운드 동기화 상태 ──
ALTER TABLE raw_sheet_rows
  ADD COLUMN IF NOT EXISTS dirty_at  TIMESTAMPTZ,   -- DB 편집됨, 아직 시트 미반영 (NULL=clean)
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ,   -- 마지막으로 시트에 반영된 시각
  ADD COLUMN IF NOT EXISTS edited_by TEXT;          -- 마지막 편집 관리자명

-- dirty 행 조회/미러 skip 판정용 partial index
CREATE INDEX IF NOT EXISTS idx_raw_rows_dirty
  ON raw_sheet_rows(sheet_id, tab_gid)
  WHERE dirty_at IS NOT NULL;

-- ── 탭 단위 편집 opt-in 플래그 (dark ship: 활성화한 탭만 그리드 편집 노출) ──
ALTER TABLE raw_sheet_tabs
  ADD COLUMN IF NOT EXISTS editable       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ;

-- ── 값-편집 감사 로그 (운영/롤백용) ──
-- op: 'cell' | 'add_row' | 'del_row' | 'add_col' | 'del_col' (Phase 2 서식은 자유롭게 확장)
CREATE TABLE IF NOT EXISTS grid_edit_log (
  id          BIGSERIAL PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  tab_gid     TEXT NOT NULL,
  tab_name    TEXT,
  op          TEXT NOT NULL,
  row_index   INTEGER,        -- 1-based (열 작업은 NULL)
  col_index   INTEGER,        -- 0-based (행 작업은 NULL)
  old_value   TEXT,
  new_value   TEXT,
  edited_by   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grid_edit_log_tab
  ON grid_edit_log(sheet_id, tab_gid, created_at DESC);
