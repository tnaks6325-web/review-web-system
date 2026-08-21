-- 134: 주문 원장 편집 이력 (작업보드 셀 편집 → 원장 되쓰기 · 사용자 확정 2026-08-21)
--
-- ★★ 왜 필요한가: 원장(`order_submissions`) 편집은 **UPDATE 덮어쓰기**다. 작업보드 셀 편집은
--   `participant_edits` 에 append-only 로 쌓여 되돌릴 수 있는데, 그 값이 원장까지 흘러가면
--   **리뷰어가 실제로 제출한 값**이 아무 데도 남지 않는다(돈·송장·계좌가 걸린 칸이다).
--   여기에 편집 직전 값을 남겨 두면 "원래 뭐였는지"를 언제든 되짚을 수 있다.
--
-- ★ 직원 화면에는 아무 것도 늘지 않는다 — 기록 전용(마찰 0). 조회는 필요할 때 SQL 로 한다.
-- ★ 가산적·비파괴: 빈 신규 테이블만 만든다. 기존 흐름 영향 0.

CREATE TABLE IF NOT EXISTS order_ledger_edit_log (
  id         BIGSERIAL PRIMARY KEY,
  os_id      UUID NOT NULL,             -- order_submissions.id (FK 미설정: 주문 소프트삭제 후에도 이력은 남는다)
  sheet_id   TEXT,
  tab_name   TEXT,
  sheet_row  INTEGER,
  field      TEXT NOT NULL,             -- price / bank / account / … (화이트리스트 값)
  old_value  TEXT,                      -- ★ 덮어쓰기 직전 **DB 가 본 값**(요청이 실어 온 값이 아니다)
  new_value  TEXT,
  source     TEXT,                      -- ledger_screen(주문원장 화면) | workdesk_cell(작업보드 셀)
  edited_by  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 그 주문의 이력을 시간순으로 (가장 흔한 조회)
CREATE INDEX IF NOT EXISTS idx_order_ledger_edit_log_os
  ON order_ledger_edit_log (os_id, created_at DESC);

-- 그 작업(탭)에서 최근에 무엇이 고쳐졌는지 훑을 때
CREATE INDEX IF NOT EXISTS idx_order_ledger_edit_log_tab
  ON order_ledger_edit_log (sheet_id, tab_name, created_at DESC);
