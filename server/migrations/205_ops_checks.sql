-- 205: 「오늘 확인할 것」 — 사람이 답해야 하는 일을 한곳에 모은다 (결정 302 · 사용자 확정 2026-10-27)
-- 첫 종류 = 케이뱅크 대량이체 통장 대조(빠진 사람 · 리뷰웹 기록 없이 나간 돈). 나중에 업체 코멘트·리뷰어 질문 등을 같은 표에 붙인다.
-- ★ 숫자(facts)는 시스템이 계산한 값 · 문장(lines)은 AI 또는 기본 문장 · 직원 답(answers)은 사람 기록.
-- ★ 가산 전용 — 새 표 하나. 기존 표·행 변경 0 · 백필 0 · 트리거 0.
-- 롤백: 코드를 되돌린 뒤 DROP TABLE ops_checks(다른 표가 참조하지 않는다).
CREATE TABLE IF NOT EXISTS ops_checks (
  id          BIGSERIAL   PRIMARY KEY,
  kind        TEXT        NOT NULL,                     -- 'bank_cluster'
  ref_key     TEXT        NOT NULL UNIQUE,              -- 'bank_cluster:<묶음 시작 ms>'
  manager     TEXT        NOT NULL DEFAULT '',          -- 만두 · 망고 · ''(모름)
  facts       JSONB       NOT NULL,                     -- 시스템이 계산한 사실
  facts_hash  TEXT        NOT NULL,
  lines       JSONB       NOT NULL DEFAULT '[]'::jsonb, -- [{key,text}]
  text_source TEXT        NOT NULL DEFAULT 'fallback',  -- 'ai' | 'fallback'
  answers     JSONB       NOT NULL DEFAULT '{}'::jsonb, -- {key:{choice,memo,by,at}}
  status      TEXT        NOT NULL DEFAULT 'open',      -- 'open' | 'done'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at     TIMESTAMPTZ,
  done_by     TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ops_checks_status ON ops_checks (status, created_at DESC);
