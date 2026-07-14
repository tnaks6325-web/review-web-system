-- 056: Track B 연결탭 비고(자유 텍스트) — 관제실 시트 '비고(인애드)' 컬럼 대응. 격리·비파괴.
--   소유지정 연결된 탭 표의 비고란. 탭당 1행 upsert(이력 불필요 — 자유 메모).
--   되돌리기 = DROP TABLE. Track A/인트라넷 무접촉. 부팅 재실행 idempotent.
CREATE TABLE IF NOT EXISTS trackb_tab_memos (
  sheet_id   TEXT NOT NULL,
  tab_name   TEXT NOT NULL,
  memo       TEXT NOT NULL DEFAULT '',
  updated_by TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_id, tab_name)
);
