-- 200: 오더·공고 맞추기 「따로 두기」 표시 (결정 284 · 사용자 확정 2026-10-23 「1.가 2.좋다」)
-- 값이 다른(연결 전) 작업을 담당자 팝업이 묻는다. 담당자가 "맞추지 않고 따로 둔다"고 정한 작업은 다시 묻지 않는다.
--   NULL  = 정하지 않음(팝업이 묻는다)
--   값    = 따로 두기로 정한 시각(팝업이 묻지 않는다 · 「오더·공고 맞추기」 화면에는 그대로 보인다 — 나중에 맞출 수 있다)
-- ★ 가산 전용 — 칸을 더하기만 한다. 기존 행 값 변경 0 · 백필 0 · 트리거 0. 연결 판정(bidir_state)·공유 저장은 이 칸을 보지 않는다.
-- 롤백: 코드를 되돌린 뒤 칸 DROP(다른 칸 영향 없음).
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS bidir_reconcile_skip_at TIMESTAMPTZ NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS bidir_reconcile_skip_by TEXT NOT NULL DEFAULT '';
