-- 035: 리뷰어용 소식·공지 (관리자 작성 → 리뷰어 홈 상단 노출)
-- 관리자 대시보드에서 작성/노출토글/삭제하고, 리뷰어 홈 상단 "소식·공지"에 표시한다.
CREATE TABLE IF NOT EXISTS reviewer_notices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,   -- 상단 고정
  active      BOOLEAN NOT NULL DEFAULT TRUE,    -- 노출 여부
  created_by  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviewer_notices_feed
  ON reviewer_notices(active, pinned DESC, created_at DESC);
