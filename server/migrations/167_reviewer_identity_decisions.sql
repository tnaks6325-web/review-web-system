-- 167: 명의 합치기·판단 기록 (조각 4 · 결정 기록 179, 사용자 확정 2026-09-25 모두 가).
--
-- 담당자가 등록리뷰어DB 에서 내린 판단을 남긴다.
--   merge            = 이름 같고 번호 다른 명의를 하나로 합침(카드만 merged 표시 · 타계정 목록은 그대로 둔다)
--   keep_separate    = 다른 사람이라 그대로 둠(그 묶음은 다시 목록에 뜨지 않는다)
--   shared_phone_ok  = 두 리뷰어에게 겹친 번호를 확인함(메모만 · 번호는 옮기거나 지우지 않는다)
-- ★ group_key 에 그 순간의 명의 구성을 담는다 — 구성이 바뀌면(새 명의 추가 등) 키가 달라져 다시 목록에 뜬다.
-- ★ 되돌리기는 지우지 않고 undone_at 을 찍는다(판단 이력 보존).
-- 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다.

CREATE TABLE IF NOT EXISTS reviewer_identity_decisions (
  id                BIGSERIAL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('merge', 'keep_separate', 'shared_phone_ok')),
  owner_reviewer_id UUID REFERENCES reviewers(id) ON DELETE CASCADE,
  group_key         TEXT NOT NULL,
  kept_card_id      UUID,
  merged_card_ids   UUID[] NOT NULL DEFAULT '{}',
  filled            JSONB NOT NULL DEFAULT '{}',   -- 합칠 때 남길 명의의 빈 칸에 채운 값(되돌리기용)
  memo              TEXT NOT NULL DEFAULT '',
  decided_by        TEXT NOT NULL DEFAULT '',
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_by         TEXT,
  undone_at         TIMESTAMPTZ
);

-- 같은 묶음에 살아 있는 판단은 하나만(경합으로 두 번 합치는 것 방지).
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_decisions_open
  ON reviewer_identity_decisions (kind, group_key) WHERE undone_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_identity_decisions_recent
  ON reviewer_identity_decisions (decided_at DESC);
