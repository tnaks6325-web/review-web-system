-- 091: 모집공고별 참여가능 리뷰어 게이트 (블랙리스트 건별 관리)
-- 기본 = 전원 참여가능(deny-list). 이 테이블에는 "예외"만 쌓인다:
--   mode='block' = 이 공고 참여 차단(+ 안내 메시지 유형) / mode='allow' = 전역 블랙리스트지만 이 공고는 허용.
-- ★ campaign_id 는 recruit_campaigns.id 와 같은 TEXT (082에서 UUID 로 선언해 42804 로
--   파일 전체가 영영 안 붙던 사고 재발 방지 — 회귀가드가 018 원본과 타입 대조).
-- ★ mode/message_type 에 DB CHECK 를 두지 않는다(어휘 확장 시 저장 실패 — 087 리뷰타입과 같은 규율).
-- 해제는 소프트(released_at) — 삭제하지 않아 "관리 이력"이 그대로 남는다.
CREATE TABLE IF NOT EXISTS campaign_reviewer_gates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  phone8        TEXT NOT NULL,
  reviewer_name TEXT,
  mode          TEXT NOT NULL,          -- 'block' | 'allow'
  message_type  TEXT,                   -- block: 'closed'(마감 위장) | 'policy'(사유 고지) / allow: NULL
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  released_at   TIMESTAMPTZ,
  released_by   TEXT
);

-- 활성 예외는 (공고, 명의)당 1행 — 코드 실수로도 중복 활성이 불가능(부분 유니크 백스톱)
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_reviewer_gates_active
  ON campaign_reviewer_gates(campaign_id, phone8) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crg_campaign ON campaign_reviewer_gates(campaign_id, created_at DESC);
