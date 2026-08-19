-- 130: 무시트 셀 편집 쓰기-through (E1)
--
-- 작업보드 셀 편집이 오버레이(participant_edits)에만 남아 무시트 작업의 원본
-- (campaign_participants.row_json)·장부(review_index)에 반영되지 않던 문제를 고친다.
--
-- ★ 컬럼 추가만 · 백필 0 · CHECK 0 (082 의 42804 규율).
-- ★ 되돌리기 = 킬스위치 SHEETLESS_CELL_WRITE=off (컬럼은 남겨도 무해).

ALTER TABLE participant_edits
  ADD COLUMN IF NOT EXISTS prev_text      TEXT,
  ADD COLUMN IF NOT EXISTS had_prev       BOOLEAN,   -- NULL=쓰기-through 아님 / FALSE=그 칸이 없었음
  ADD COLUMN IF NOT EXISTS wrote_row_json BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS ledger_dirty_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tab_configs_ledger_dirty
  ON tab_configs (ledger_dirty_at) WHERE ledger_dirty_at IS NOT NULL;
