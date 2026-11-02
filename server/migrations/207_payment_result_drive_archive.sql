-- 207: 이체결과 파일 드라이브 보관(결정 316).
--   결과 파일 원본은 이미 payment_result_uploads.file_blob(109)에 있다. 같은 파일을 여러 번 놓으면 그 표에는 줄이
--   여러 개 생기므로, 드라이브 사본은 **파일 내용(sha256) 하나에 한 번**만 올린다 — 이 표가 그 장부다.
--   반영·입금 기록과 무관한 보관 장부라 지워도 돈 기록은 그대로다(돈 표 아님).
CREATE TABLE IF NOT EXISTS payment_result_drive_archive (
  file_sha256     TEXT PRIMARY KEY,
  upload_id       UUID,
  status          TEXT NOT NULL DEFAULT 'failed',
  attempts        INTEGER NOT NULL DEFAULT 0,
  drive_file_id   TEXT,
  drive_folder_id TEXT,
  root_folder_id  TEXT,
  drive_name      TEXT NOT NULL DEFAULT '',
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at     TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE payment_result_drive_archive
    ADD CONSTRAINT payment_result_drive_archive_status_check
    CHECK (status IN ('done', 'failed', 'blocked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_result_drive_archive_status
  ON payment_result_drive_archive (status, updated_at);
