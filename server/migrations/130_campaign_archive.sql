-- 130: 모집공고 보관(폐기) — 끝난 공고를 화면에서 내린다.
--
-- ★★ status 에 새 값을 넣지 않는다(018 CHECK: draft|active|closed).
--   computeCampaignState·apply 게이트·목록 정렬 등 십수 곳이 `status==='active'` 를 보고 있어,
--   CHECK 를 넓히는 순간 그 전부를 훑어야 한다. **보관은 노출 축**이지 상태 축이 아니다
--   (085 reviewer_hidden 과 같은 판단 — 그쪽은 "리뷰어에게만 숨김", 이쪽은 "일이 끝나 목록에서 내림").
--
-- ★ 컬럼 추가만 · 백필 0 · CHECK 0 · FK 0  → 배포 즉시 동작 100% 불변(NULL = 보관 안 됨).
-- ★ 되돌리기 = archived_at 을 NULL 로(데이터는 한 줄도 지우지 않는다).
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS archived_by TEXT;

-- 목록의 기본 조건이 `archived_at IS NULL` 이라 부분 인덱스로 받는다(보관분이 쌓여도 목록은 그대로).
CREATE INDEX IF NOT EXISTS idx_recruit_campaigns_active_not_archived
  ON recruit_campaigns (created_at DESC) WHERE archived_at IS NULL;
