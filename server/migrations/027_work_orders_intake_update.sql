-- 인트라넷 "리뷰 오더" 작업오더 수정 연동 (PATCH/PUT /api/order/intake/:id)
-- 인트라넷에서 기존 작업오더를 수정하면 리뷰웹 인박스 원본도 함께 갱신된다.
-- manager_name   : 담당자명 (인트라넷 수정 payload 포함, 기존 스키마에 없던 컬럼)
-- updated_by      : 마지막 수정 요청자 username (감사용, deleted_by 패턴과 동일)
-- updated_by_name : 마지막 수정 요청자 표시명 (감사용)
-- ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS manager_name    TEXT DEFAULT '';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_by      TEXT DEFAULT '';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_by_name TEXT DEFAULT '';
