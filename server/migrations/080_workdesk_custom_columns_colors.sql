-- 080: 통합 작업대 커스텀 열(행별 자유메모) + 셀 배경색(드래그 범위 지정) — Track B 전용 오버레이.
--   ★ participant_edits / write-back 파이프라인과 완전 분리된 신규 테이블만 추가한다(기존 로직 0줄 변경).
--     이 값들은 시트에 절대 쓰지 않으므로 write-back 의 disjoint·guard·tier 불변식과 무관하다.
--   되돌리기 = 라우트 미마운트 + 이 3개 테이블 DROP.

-- 탭별 커스텀 열 정의(시트에 없는 자유메모 열). 탭 공용 — 그 탭을 보는 모든 관리자/AE에게 동일하게 보인다.
CREATE TABLE IF NOT EXISTS trackb_custom_columns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id     TEXT NOT NULL,
  tab_name     TEXT NOT NULL,
  col_name     TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ                    -- soft delete(감사·복원 여지 보존)
);
CREATE INDEX IF NOT EXISTS idx_trackb_custom_columns_tab
  ON trackb_custom_columns (sheet_id, tab_name) WHERE deleted_at IS NULL;

-- 행별 값. 앵커는 participant_edits 와 동일 철학(order UUID > manual 물리행 UUID > identity_key)
--   — 정렬/재투영이 물리행을 덮어써도 메모 값이 유실·오염되지 않는다.
CREATE TABLE IF NOT EXISTS trackb_custom_column_values (
  id           BIGSERIAL PRIMARY KEY,
  column_id    UUID NOT NULL REFERENCES trackb_custom_columns(id) ON DELETE CASCADE,
  anchor_type  TEXT NOT NULL CHECK (anchor_type IN ('order','manual','identity')),
  anchor_value TEXT NOT NULL,
  value_text   TEXT,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_custom_column_values
  ON trackb_custom_column_values (column_id, anchor_type, anchor_value);

-- 드래그 범위 셀 배경색(엑셀식 셀 하이라이트). field = 'col:<시트헤더>' | 'ccol:<커스텀열id>' | 'idname' | 'idphone'.
--   행은 위와 동일한 앵커 철학 — 행이 재투영/정렬돼도 칠한 색이 같은 행을 계속 따라간다.
CREATE TABLE IF NOT EXISTS trackb_cell_colors (
  id           BIGSERIAL PRIMARY KEY,
  sheet_id     TEXT NOT NULL,
  tab_name     TEXT NOT NULL,
  anchor_type  TEXT NOT NULL CHECK (anchor_type IN ('order','manual','identity')),
  anchor_value TEXT NOT NULL,
  field        TEXT NOT NULL,
  color        TEXT NOT NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_cell_colors
  ON trackb_cell_colors (sheet_id, tab_name, anchor_type, anchor_value, field);
CREATE INDEX IF NOT EXISTS idx_trackb_cell_colors_tab
  ON trackb_cell_colors (sheet_id, tab_name);
