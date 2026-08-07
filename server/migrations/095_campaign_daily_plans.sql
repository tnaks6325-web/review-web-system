-- 095: 모집공고 날짜별 모집 계획(조절) + 차수(물량 추가) 원장 + 조절 이력
-- 배경: 업체 요청으로 "오늘은 20명만/오늘만 +10명"을 반영할 수단이 없어, 의도적 축소를
--   시스템이 "미달"로 오해해 다음날 자동 이월(60명)하는 사고가 났다.
--   시안 = frontend/docs/모집인원조절_이월차수_와이어프레임.html (사용자 확정 3건 반영).
-- ★ campaign_id 는 recruit_campaigns.id 와 같은 TEXT (082에서 UUID 로 선언해 42804 로
--   파일 전체가 영영 안 붙던 사고 재발 방지 — 회귀가드가 018 원본과 타입 대조).
-- ★ 계획/차수 행이 하나도 없는 캠페인 = 기존 동작 100% (옵트인 — 백필 0).

-- 날짜별 모집 계획: 값이 있는 날만 저장(없는 날 = 기본 일건수 daily_limit).
-- 명시 조절일은 "그날의 전부"가 그 값 — 자연 이월도 그날엔 얹지 않는다("오늘은 N명만"의 의미).
CREATE TABLE IF NOT EXISTS campaign_daily_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  plan_date     DATE NOT NULL,
  planned_count INT  NOT NULL CHECK (planned_count >= 0),
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, plan_date)   -- 같은 날 두 계획은 구조적으로 불가능
);

-- 차수 원장: 총량을 늘리는 유일한 창구. 초도분은 첫 차수 추가 때 1차로 흡수(시드).
-- recruit_total 은 차수 합계로 동기화된다(차수가 있는 공고의 총모집 직접 수정은 서버가 무시).
CREATE TABLE IF NOT EXISTS campaign_rounds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  round_no    INT  NOT NULL,
  slot_count  INT  NOT NULL CHECK (slot_count > 0),
  start_date  DATE,
  label       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, round_no)
);

-- 조절 이력(원칙 ⑦): 누가 언제 어느 날을 몇 명으로 바꿨고 빠진 인원을 어떻게 처리했는지.
CREATE TABLE IF NOT EXISTS campaign_plan_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  actor       TEXT,
  action      TEXT NOT NULL,     -- 'plan_save' | 'round_add' | 'round_remove' (DB CHECK 없음 — 087 규율)
  detail      JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cpe_campaign ON campaign_plan_events(campaign_id, created_at DESC);
