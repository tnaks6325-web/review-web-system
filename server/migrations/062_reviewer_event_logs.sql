-- ═══════════════════════════════════════════════════════════
-- 062: 리뷰어 비정상 이벤트 한글 로그 + 구매캡처↔주문 연결 + written 사후검증 기반
--
-- 배경(7/24 이지유 사건): 구매양식이 DB에 정상 접수(written)됐지만 시트의 기록 행이
--   이후 다른 데이터로 덮여 "유령 written"(DB=성공, 시트=없음)으로 3일간 잠복.
--   written은 종결 상태라 기존 자동복구(reconcile)가 다시 보지 않았음.
-- 이 마이그레이션은 ① 캠페인별 한글 자연어 로그 원장(통합작업대 로그 창 + 관리자 중요알림 소스),
--   ② 캡처 업로드↔주문 연결 컬럼(캡처 미첨부 감지), ③ written 사후검증 스탬프를 추가한다.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reviewer_event_logs (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sheet_id      TEXT NOT NULL DEFAULT '',
  tab_name      TEXT NOT NULL DEFAULT '',
  tab_gid       TEXT,
  campaign_name TEXT NOT NULL DEFAULT '',   -- 표시용 캠페인/탭 라벨(디노멀라이즈 — 조회 시 조인 불필요)
  reviewer_name TEXT NOT NULL DEFAULT '',
  phone8        TEXT NOT NULL DEFAULT '',
  event_type    TEXT NOT NULL,              -- order_lost | order_lost_manual | order_row_shifted | order_unmirrored | order_no_capture …
  severity      TEXT NOT NULL DEFAULT 'warn',  -- critical | warn | info
  message       TEXT NOT NULL,              -- 한글 자연어 문장(그대로 화면 표시)
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  order_submission_id UUID,
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviewer_logs_open
  ON reviewer_event_logs (occurred_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reviewer_logs_tab
  ON reviewer_event_logs (sheet_id, tab_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviewer_logs_order
  ON reviewer_event_logs (order_submission_id) WHERE order_submission_id IS NOT NULL;

-- 같은 주문·같은 유형의 "미해결" 로그는 1건만 유지(주기 감지 크론이 같은 건을 도배하지 않게).
-- 해결(resolved) 후 재발하면 새 로그가 다시 쌓인다(이력 보존).
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviewer_logs_open_order
  ON reviewer_event_logs (event_type, order_submission_id)
  WHERE resolved_at IS NULL AND order_submission_id IS NOT NULL;

-- 캡처 업로드↔주문 연결 + written 사후검증 스탬프
ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS capture_file_id     TEXT,
  ADD COLUMN IF NOT EXISTS capture_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_verified_at     TIMESTAMPTZ;

-- 캡처 미첨부 감지 컷오프: 이 시각 이전 제출분은 감지 제외(과거 주문 전체가 연결 컬럼 NULL이라
-- 배포 직후 소급 오탐이 쏟아지는 것을 방지). ON CONFLICT DO NOTHING = 재배포 시 재실행 안전.
INSERT INTO app_settings (key, value, updated_at)
VALUES ('reviewer_log_capture_cutoff', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), NOW())
ON CONFLICT (key) DO NOTHING;
