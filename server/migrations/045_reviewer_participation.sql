-- 045: 리뷰어 직접참여 캠페인 M1 — 스키마 확장 (PRD: frontend/docs/prd-reviewer-participation.html §06-A)
-- ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
-- ※ 가산적·비파괴: participation_mode 기본 FALSE — 기존 공고/신청 흐름 무영향(레거시 경로 유지).

-- ── recruit_campaigns: 참여형 공고 정책 컬럼 ─────────────────────────
ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS participation_mode BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE=참여형(신규 상태엔진/홀드), FALSE=레거시(현행 유지)
  ADD COLUMN IF NOT EXISTS thumbnail_url      TEXT DEFAULT '',                -- 상품 썸네일(사전 공개)
  ADD COLUMN IF NOT EXISTS landing_url        TEXT DEFAULT '',                -- 랜딩페이지(신청 후 공개)
  ADD COLUMN IF NOT EXISTS daily_limit        INTEGER DEFAULT 0,              -- 일일진행건수(참여형 필수 >=1)
  ADD COLUMN IF NOT EXISTS recruit_total      INTEGER DEFAULT 0,              -- 총 모집인원(0=무제한, 리뷰어 미표시)
  ADD COLUMN IF NOT EXISTS window_start       TIME,                           -- 구매시간창 시작(KST)
  ADD COLUMN IF NOT EXISTS window_end         TIME,                           -- 구매시간창 종료(KST)
  ADD COLUMN IF NOT EXISTS close_buffer_min   INTEGER DEFAULT 10,             -- 종료 전 신규신청 차단 버퍼(분)
  ADD COLUMN IF NOT EXISTS hold_ttl_min       INTEGER DEFAULT 15,             -- 홀드 제한시간(분) — 구매+양식 제출완료까지
  ADD COLUMN IF NOT EXISTS work_detail        JSONB,                          -- 작업내용 스냅샷(신청 후 공개; 내부필드 복사 금지, sanitize된 HTML)
  ADD COLUMN IF NOT EXISTS source_work_order_id TEXT DEFAULT '';              -- 발행 원천 작업오더 id(참고용, FK 없음)

-- ── campaign_applications: 홀드 라이프사이클 ────────────────────────
ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS phone8              TEXT DEFAULT '',        -- 연락처 끝 8자리(서버 파생 — 클라이언트 입력 불신)
  ADD COLUMN IF NOT EXISTS expires_at          TIMESTAMPTZ,            -- 홀드 만료시각 = min(now+TTL, 당일 window_end)
  ADD COLUMN IF NOT EXISTS submitted_at        TIMESTAMPTZ,            -- 제출확정 시각(전일까지 누적확정 = dailyQuota 분모 계산 기준)
  ADD COLUMN IF NOT EXISTS order_submission_id BIGINT,                 -- 확정 링크(order_submissions.id)
  ADD COLUMN IF NOT EXISTS hold_token          TEXT DEFAULT '',        -- 열람·취소 열쇠(신청 응답으로 발급)
  ADD COLUMN IF NOT EXISTS late_order_id       BIGINT;                 -- 만료 후 도착한 제출의 주문 id(자동확정 없음 — 관제 수동확정 대상 표기)

-- status CHECK 확장: 기존 CHECK(confirmed/cancelled)를 참여형 상태 포함으로 교체.
--   'confirmed'는 레거시 전용 상태로 보존(신형 카운트·유니크에서 제외).
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'campaign_applications'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE campaign_applications DROP CONSTRAINT %I', c.conname);
  END LOOP;
  BEGIN
    ALTER TABLE campaign_applications
      ADD CONSTRAINT campaign_applications_status_check
      CHECK (status IN ('confirmed','cancelled','applied','submitted','expired'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- 구 UNIQUE(campaign_id, applicant_name, applicant_phone) DROP:
--   유지 시 expired/cancelled 행이 키를 영구 점유해 다음 날 재신청까지 23505로 전부 실패(PRD §06-A).
--   당일 재신청 차단은 apply의 "당일(KST) 이력 존재" 검사(SQL)로 수행한다.
DO $$
DECLARE u RECORD;
BEGIN
  FOR u IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'campaign_applications'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE campaign_applications DROP CONSTRAINT %I', u.conname);
  END LOOP;
END $$;

-- phone8 백필(레거시 행): 숫자만 남긴 끝 8자리. 신규 신청은 서버가 파생 저장.
UPDATE campaign_applications
   SET phone8 = RIGHT(regexp_replace(COALESCE(applicant_phone,''), '\D', '', 'g'), 8)
 WHERE (phone8 IS NULL OR phone8 = '')
   AND COALESCE(applicant_phone,'') <> '';

-- 참여형 중복 방지(익일 재신청형): 활성(applied)·확정(submitted)만 1건 — expired/cancelled/레거시(confirmed)는 제외.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_active_hold
  ON campaign_applications (campaign_id, phone8)
  WHERE status IN ('applied','submitted');

-- 카운트/게이트용 인덱스 (유효홀드 판정은 항상 status+expires_at 시각 기준 — 스윕은 정리용)
CREATE INDEX IF NOT EXISTS idx_campaign_apps_state
  ON campaign_applications (campaign_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_campaign_apps_submitted
  ON campaign_applications (campaign_id, submitted_at) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS idx_campaign_apps_hold_by_phone
  ON campaign_applications (phone8) WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS idx_campaign_apps_daily
  ON campaign_applications (campaign_id, phone8, applied_at);

-- ── order_submissions: 홀드 확정 링크 ───────────────────────────────
ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS campaign_application_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_order_submissions_campaign_app
  ON order_submissions (campaign_application_id) WHERE campaign_application_id IS NOT NULL;
