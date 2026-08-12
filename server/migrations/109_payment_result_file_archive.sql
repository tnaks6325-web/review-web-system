-- 109: 이체 결과 원본 파일 보관 및 회차별 반영 요약
-- 원문은 관리자 전용 반영 경로에서만 읽고, 조회 응답에는 포함하지 않는다.
ALTER TABLE payment_result_uploads ADD COLUMN IF NOT EXISTS file_blob BYTEA;
ALTER TABLE payment_result_uploads ADD COLUMN IF NOT EXISTS file_sha256 TEXT;
ALTER TABLE payment_result_uploads ADD COLUMN IF NOT EXISTS applied_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_result_uploads ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
