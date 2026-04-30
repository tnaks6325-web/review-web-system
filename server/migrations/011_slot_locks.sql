-- 011: 구매양식 슬롯 매칭 시스템
-- 제출자가 시트의 인애드명 행에 자동 매칭되어 기존 행에 데이터 기록

CREATE TABLE IF NOT EXISTS slot_locks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  row_number      INTEGER NOT NULL,       -- 시트 행 번호 (1-based)
  inad_name       TEXT,                   -- 시트의 인애드명 값
  locked_by_phone8 TEXT NOT NULL,         -- 잠근 리뷰어 phone8
  locked_by_name  TEXT,                   -- 잠근 리뷰어 이름
  profile_name    TEXT,                   -- 사용된 프로필 이름
  is_submitted    BOOLEAN DEFAULT FALSE,  -- 제출 완료 여부
  locked_at       TIMESTAMPTZ DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  UNIQUE(sheet_id, tab_name, row_number)
);

CREATE INDEX IF NOT EXISTS idx_slot_locks_sheet_tab ON slot_locks(sheet_id, tab_name);
CREATE INDEX IF NOT EXISTS idx_slot_locks_phone8 ON slot_locks(locked_by_phone8);
