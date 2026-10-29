-- 206: 공유 전송은 저장 목적에 맞는 범위만 보낸다.
-- 기존 행은 전체 공유 상태 전송으로 유지하고, 담당자 전용 변경은 work_manager만 보낸다.
ALTER TABLE shared_sync_outbox
  ADD COLUMN IF NOT EXISTS view_scope TEXT NOT NULL DEFAULT 'full';

DO $$ BEGIN
  ALTER TABLE shared_sync_outbox
    ADD CONSTRAINT shared_sync_outbox_view_scope_check
    CHECK (view_scope IN ('full', 'manager'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
