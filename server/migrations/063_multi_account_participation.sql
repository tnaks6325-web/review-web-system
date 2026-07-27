-- 063: 모집공고 타계정 추가참여 1단계 — 공고 토글·타계정 하루한도·소유자 귀속 (PRD: frontend/docs/prd-multiaccount-participation.html v1.1 §09)
-- ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
-- ※ 가산적·비파괴: multi_account_mode 기본 FALSE(§09-1) — 배포만으로 동작이 바뀌는 공고 없음. 롤백 = 코드 롤백(컬럼 잔존 무해).
-- ※ uq_campaign_apps_active_hold (campaign_id, phone8) 는 의도적으로 무변경 —
--    홀드는 계속 "명의 phone8"로 키잉(같은 공고에 같은 명의 한 번만 = §02, 누가 등록한 명의든 동일 적용).
--    같은번호 공유 타계정(A안)은 apply가 sub_shares_owner_phone 으로 거부(phone8=검색·행배정·입금대사 신원키 보호).

ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS multi_account_mode BOOLEAN NOT NULL DEFAULT FALSE, -- §09-1 타계정 참여 [가능]/[불가], 기본 [불가]
  ADD COLUMN IF NOT EXISTS multi_daily_limit  INTEGER DEFAULT 0,              -- §09-5 "한 사람의 타계정 참여 하루 N건"(0=무제한)
  ADD COLUMN IF NOT EXISTS sub_hold_ttl_min   INTEGER DEFAULT 10;             -- §09-2 타계정 건 제한시간(분, 기본 10 — 본계정 hold_ttl_min=15와 별도)

-- 소유자 귀속(서버 파생 — 클라이언트 입력 불신). NULL=레거시 행 — 판정은 COALESCE(owner_phone8, phone8).
ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS owner_phone8 TEXT;

-- §09-2 소유자 합산 동시홀드 상한용(유효홀드 판정은 항상 시각 기준 status+expires_at — 스윕은 정리용)
CREATE INDEX IF NOT EXISTS idx_campaign_apps_owner_active
  ON campaign_applications ((COALESCE(owner_phone8, phone8))) WHERE status = 'applied';
-- §09-5 캠페인별 타계정 하루한도 집계용
CREATE INDEX IF NOT EXISTS idx_campaign_apps_owner_daily
  ON campaign_applications (campaign_id, owner_phone8, applied_at) WHERE owner_phone8 IS NOT NULL;
