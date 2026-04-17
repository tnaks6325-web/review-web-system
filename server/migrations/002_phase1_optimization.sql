-- ============================================================
-- Phase 1: 인덱스 빌드 최적화를 위한 스키마 확장
-- Drive API 변경감지용 sheet_modified_at 컬럼 추가
-- ============================================================

-- index_master에 시트 수정시각 컬럼 추가
-- Drive API에서 받은 modifiedTime을 저장하여
-- 다음 빌드 시 변경 여부를 빠르게 판단 (0.1초에 스킵 가능)
ALTER TABLE index_master
  ADD COLUMN IF NOT EXISTS sheet_modified_at TIMESTAMPTZ;

-- sync_queue 테이블 (Phase 2에서 사용하지만 미리 생성)
-- Sheets API 쓰기 실패 시 자동 재시도를 위한 큐
CREATE TABLE IF NOT EXISTS sync_queue (
  id            SERIAL PRIMARY KEY,
  type          TEXT NOT NULL,              -- 'sheet_write', 'sheet_append'
  payload       JSONB NOT NULL,             -- { sheetId, range, values, ... }
  status        TEXT DEFAULT 'pending',     -- pending → processing → done / failed
  attempts      INTEGER DEFAULT 0,
  max_retry     INTEGER DEFAULT 3,
  error_msg     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON sync_queue(created_at);

-- 빌드 성능 로그 테이블 (Phase 5에서 히스토리 표시용)
CREATE TABLE IF NOT EXISTS build_history (
  id          SERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  elapsed_ms  INTEGER,
  rebuilt     INTEGER DEFAULT 0,
  skipped     INTEGER DEFAULT 0,
  errors      INTEGER DEFAULT 0,
  total       INTEGER DEFAULT 0,
  trigger_by  TEXT,               -- 'manual', 'cron', 'cron_full'
  build_log   JSONB
);
