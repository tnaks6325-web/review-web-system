-- 129: 작업표 줄 "표에서 분리"(보관) 표식 — 2026-08-19 사용자 확정
--
-- 왜: 8/18~19 중복 반영으로 생긴 줄 중 **이체 근거가 걸려 지울 수 없는 줄**이 작업표에 남아
--   담당자가 매일 그것을 지나쳐야 했다. 지우면(soft delete) 그 줄이 들고 있던 입금 표시·회차
--   항목이 표에서 사라져, 남길 줄이 미입금으로 보이면 **다음 회차에 다시 담겨 이중 송금**이 난다.
--
-- ★★ 그래서 이 표식은 **화면에서만** 뺀다(사용자 확정 "표에서만 빼기"):
--   · 장부 재생성(review_index/raw 미러)·리뷰어 검색·입금대상 추출은 **한 글자도 안 바뀐다**
--   · `deleted_at` 과 다른 컬럼인 이유 = 삭제가 아니다. 되돌리기가 기본이고 이력이 남는다.
-- ★ 컬럼 추가만 · 백필 0 · CHECK 0 → 배포 즉시 동작 100% 불변(값이 NULL 이면 종전 그대로).
ALTER TABLE campaign_participants
  ADD COLUMN IF NOT EXISTS held_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_reason TEXT,
  ADD COLUMN IF NOT EXISTS held_by     TEXT;

-- 그리드 조회가 `held_at IS NULL` 로 거르므로 부분 인덱스로 충분하다(분리된 줄은 소수).
CREATE INDEX IF NOT EXISTS idx_participants_held
  ON campaign_participants(sheet_id, tab_name) WHERE held_at IS NOT NULL;
