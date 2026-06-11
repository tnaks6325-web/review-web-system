-- 작업 오더 soft delete: 인트라넷 "보낸 오더" 삭제 연동 (DELETE /api/order/intake/:id)
-- 실제 행은 보존(처리 이력·memo_log 유지)하고 deleted_at 으로 목록에서 제외한다.
-- ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;       -- null = 활성
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_by      TEXT DEFAULT '';   -- 삭제 요청자 username
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_by_name TEXT DEFAULT '';   -- 삭제 요청자 표시명
