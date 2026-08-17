-- 115: 인기상품별 선행참여 비인기 공고 우선순위.
-- 첫 공고가 모집완료(마감 또는 총 모집인원 충족)되면 다음 priority가 자동 대상이 된다.
CREATE TABLE IF NOT EXISTS campaign_popular_prerequisites (
  popular_campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  prerequisite_campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL CHECK (priority > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (popular_campaign_id, prerequisite_campaign_id),
  UNIQUE (popular_campaign_id, priority),
  CHECK (popular_campaign_id <> prerequisite_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_popular_prerequisites_queue
  ON campaign_popular_prerequisites (popular_campaign_id, priority);
