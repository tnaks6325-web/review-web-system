-- 055: Track B 마감자료 원장 — 탭별 리뷰완료 증빙 스냅샷(생성 이력 보존). 격리·가산·비파괴.
--   제출률 100%(또는 부분마감) 시 Track B 명단으로 마감자료 CSV 생성 + 마감일 자동 기록.
--   되돌리기 = DROP TABLE. Track A/인트라넷 무접촉. 부팅 재실행 idempotent.
CREATE TABLE IF NOT EXISTS trackb_tab_closeouts (
  id          BIGSERIAL PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  tab_name    TEXT NOT NULL,
  closed_date DATE NOT NULL,          -- 마감일(생성 시점, KST)
  row_count   INTEGER DEFAULT 0,      -- 마감 건수(생성 시점 활성 명단)
  sub_count   INTEGER DEFAULT 0,      -- 그 중 제출완료 건수
  created_by  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trackb_closeout_tab
  ON trackb_tab_closeouts (sheet_id, tab_name) WHERE deleted_at IS NULL;
