-- 064: 모집공고 별표 고정(우선노출) + 인기상품 배지·선행참여 게이트
-- ※ migrate.js/부팅 경로 모두 재실행 안전해야 함 — idempotent(IF NOT EXISTS).
-- ※ 가산적·비파괴: pinned_at NULL(미고정)·is_popular FALSE(일반) 기본 — 배포만으로 순서·동작이 바뀌는 공고 없음.
--    (노출순서 sort_order 컬럼은 드롭하지 않음 — UI·정렬에서만 제거, 데이터 보존 = 롤백 안전)

ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS pinned_at  TIMESTAMPTZ,                     -- 별표 고정 시각(NULL=미고정). 먼저 별표한 공고가 위(ASC)
  ADD COLUMN IF NOT EXISTS is_popular BOOLEAN NOT NULL DEFAULT FALSE;  -- [인기!] 배지 + 선행참여(일반 1건 제출완료당 인기 1건) 게이트
