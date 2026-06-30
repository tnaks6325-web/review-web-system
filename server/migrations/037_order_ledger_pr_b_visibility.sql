-- 037: 주문 원장 PR-B 신규 상태(conflict, canceled_sheet_dirty) 가시화 인덱스
-- Idempotent, additive, 비파괴(기존 idx_os_alive_stuck 건드리지 않음).
-- canceled_sheet_dirty는 deleted_at이 세팅되므로 idx_os_alive_stuck(deleted_at IS NULL) 밖이다.
-- → 관리자 진단 위젯/COUNT가 충돌·dirty 취소를 놓치지 않도록 전용 부분인덱스를 추가.
CREATE INDEX IF NOT EXISTS idx_os_attention
  ON order_submissions (sheet_id, tab_name)
  WHERE mirror_status IN ('conflict','canceled_sheet_dirty');
