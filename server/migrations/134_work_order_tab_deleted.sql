-- 134: 작업오더 — 연결 작업(작업표)이 삭제된 시각 표시 (사용자 확정 2026-08-21)
--
-- 왜: 홈 작업목록 [⋯] → [작업 삭제]는 연결 작업오더의 링크(linked_tab_*)를 **비우기만** 하고
--     오더 자체는 남긴다(같은 오더를 다시 접수할 수 있게). 그래서 목록에서는 그 오더가
--     "아직 접수 안 한 오더"와 똑같이 보였고, **언제 무엇이 지워졌는지 아무 데도 남지 않았다**.
--
-- ★ 컬럼 추가만 · 백필 0 — 배포 즉시 동작 불변(값이 없으면 화면이 아무것도 그리지 않는다).
-- ★ 되살리기: 재접수하면 accept 가 이 세 칸을 비운다(화면이 거짓을 말하지 않게).
--   그때도 memo_log 의 삭제 기록은 남으므로 이력은 보존된다.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tab_deleted_at  TIMESTAMPTZ;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tab_deleted_by  TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tab_deleted_tab TEXT;
