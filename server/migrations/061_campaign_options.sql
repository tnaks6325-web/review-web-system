-- 061: 참여형 캠페인 상품옵션 — 옵션별 정원·일일한도·금액 + 신청의 선택옵션 (PRD: frontend/docs/prd-campaign-options.html v1.1)
-- ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
-- ※ 가산적·비파괴: 옵션 미등록 공고는 동작 불변(opt-in). 옵션은 참여형(participation_mode) 공고에서만 사용.

-- ── 옵션 원장(캠페인 1:N) ──────────────────────────────────
--   opt_key = 옵션 식별자 겸 표시명 겸 시트 옵션열 기입값(selected_opt_key). 파이프 '|'는
--   기존 다중옵션 구분자라 서버가 저장 전 제거(내부 키 포맷 충돌 방지).
CREATE TABLE IF NOT EXISTS campaign_options (
  id            SERIAL PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  opt_key       TEXT NOT NULL,                 -- 옵션명(=시트 기입값). 서버 정규화(trim, '|' 제거, 200자)
  pay_amount    INTEGER DEFAULT 0,             -- 옵션별 결제금액(0=캠페인 공통 review_fee/안내 금액 사용)
  recruit_total INTEGER DEFAULT 0,             -- 옵션별 정원(0=무제한)
  daily_limit   INTEGER DEFAULT 0,             -- 옵션별 하루 한도(0=옵션 일일제한 없음 → 캠페인 daily_limit만 적용)
  sort_order    INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active',         -- 'active' | 'closed'(참여자 있는 옵션의 수동 마감 — 삭제 대체)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 캠페인 내 옵션명 유일(대소문/공백은 서버 정규화 후 저장이라 정확 일치 유니크로 충분)
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_options_key
  ON campaign_options (campaign_id, opt_key);

-- 옵션 목록 조회(정렬)·상태 필터용
CREATE INDEX IF NOT EXISTS idx_campaign_options_camp
  ON campaign_options (campaign_id, status, sort_order);

-- ── 신청(홀드/제출)의 선택 옵션 ────────────────────────────
--   NULL = 옵션 없는 공고(현행 경로 — 어떤 옵션 게이트도 적용 안 됨).
ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS option_key TEXT;

-- 옵션별 카운트(유효홀드/제출) 집계용 — (campaign_id, option_key, status) 필터·GROUP BY
CREATE INDEX IF NOT EXISTS idx_campaign_apps_option
  ON campaign_applications (campaign_id, option_key, status)
  WHERE option_key IS NOT NULL;
