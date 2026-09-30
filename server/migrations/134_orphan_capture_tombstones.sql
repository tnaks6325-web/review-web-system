-- ═══════════════════════════════════════════════════════════
-- 134: 고아 캡처 묘비 — 작업이 통째로 삭제될 때 그 캡처의 좌표를 남긴다
--
-- 왜: `workTabDelete` 는 `review_submissions`·`order_submissions` 를 **실제 DELETE** 한다.
--   그래서 작업을 지우면 Drive 파일은 남는데 그 파일을 가리키던 원장이 통째로 사라져
--   **DB 기준으로는 존재를 알 방법이 영영 없다**(2026-08-21 정리: C종류 = 탐지 불가).
--   지우기 **직전에** 파일 좌표만 여기 남겨 두면, 고아 캡처 정리가 그 뒤로도 찾을 수 있다.
--
-- ★ 여기 남는 것은 **좌표뿐**이다(파일ID·이름·어느 작업이었는지·왜 고아가 됐는지).
--   구매양식 내용·리뷰 내용은 담지 않는다 — 원장이 아니라 청소 목록이다.
-- ★ `file_id` 유니크 — 같은 파일이 두 번 기록되지 않는다(재실행 안전).
-- ★ 처리되면 지우지 않고 `resolved_at` 을 찍는다(무엇을 언제 치웠는지 남긴다).
-- 비파괴적: 신규 테이블만.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS orphan_capture_tombstones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id      TEXT NOT NULL,              -- Drive 파일 ID
  file_name    TEXT,
  sheet_id     TEXT,                       -- 사라진 작업의 좌표(표시용 — 판정 근거 아님)
  tab_name     TEXT,
  reviewer_name TEXT,
  slot_key     TEXT,                       -- 'review' | 'receipt' | ... (기록 당시 값)
  reason       TEXT NOT NULL,              -- 'work_deleted' 등 — 왜 고아가 됐는가
  recorded_by  TEXT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,                -- 휴지통 이동 완료 시각(NULL = 아직 남아 있음)
  resolved_by  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orphan_tombstone_file ON orphan_capture_tombstones(file_id);
CREATE INDEX IF NOT EXISTS idx_orphan_tombstone_open
  ON orphan_capture_tombstones(recorded_at) WHERE resolved_at IS NULL;
