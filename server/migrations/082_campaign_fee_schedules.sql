-- ═══════════════════════════════════════════════════════════
-- 082: 캠페인 기간별 리뷰비 (구간표 + 참여시점 스냅샷)
--
-- 배경(2026-08 사고): 리뷰비는 recruit_campaigns.review_fee **한 칸**뿐이고
--   리뷰어 화면은 조회할 때마다 그 값을 다시 읽는다. 7월 1,000원 → 8월 1,500원으로
--   올리는 순간 **7월 참여자의 과거 카드·누적 합계까지 1,500원**이 되어
--   "1,500원이라면서 왜 1,000원만 들어왔냐"는 문의가 발생했다.
--
-- 모델(설계안: frontend/docs/design-campaign-fee-schedule.html)
--   ① 구간표 = 앞으로 줄 금액("7/1부터 1,000 · 8/1부터 1,500")
--   ② 스냅샷 = 이미 준 금액(참여 확정 시 그 건에 새김 — 나중에 구간을 고쳐도 불변)
--
-- 비파괴: 신규 테이블 1 + 컬럼 추가 2. **구간이 0개면 기존 review_fee 폴백 = 현재 동작 그대로**(opt-in).
--   되돌리기 = 이 파일 드롭 + env CAMPAIGN_FEE_SCHEDULE=0.
--   ※ migrate.js 는 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
-- ═══════════════════════════════════════════════════════════

-- ① 구간표 — **시작일만** 저장한다.
--    ★ 종료일을 함께 받으면 관리자가 7/31과 8/1 사이에 빈 하루를 만들거나 구간을 겹치게
--      입력할 수 있고, 그날 참여한 건은 금액이 사라진다. 시작일만 받으면
--      "다음 구간 시작 전날까지" 가 자동이라 **빈틈·겹침이 구조적으로 불가능**하다.
CREATE TABLE IF NOT EXISTS campaign_fee_schedules (
  id             BIGSERIAL PRIMARY KEY,
  campaign_id    UUID NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,                       -- KST 날짜. 이 날부터 적용
  review_fee     INTEGER NOT NULL CHECK (review_fee >= 0),
  memo           TEXT DEFAULT '',                     -- 관리자 전용 메모(리뷰어 미노출)
  created_by     TEXT DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 같은 날 두 금액 = 어느 쪽인지 정할 수 없음 → DB가 막는다(UI 자동점검의 최종 방어).
  CONSTRAINT uq_campaign_fee_sched UNIQUE (campaign_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_campaign_fee_sched_camp
  ON campaign_fee_schedules(campaign_id, effective_from);

-- ② 참여시점 고정(스냅샷).
--    ★ 참여(홀드 생성) 시점에 기록한다 = **리뷰어가 화면에서 본 금액**(사용자 확정 Q1: 기준일 = 참여일).
--    ★ 값이 있으면 어떤 경우에도 이 값이 이긴다 — 구간표를 나중에 고쳐도 이미 참여한 건은 불변.
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS review_fee_snapshot INTEGER;
ALTER TABLE order_submissions     ADD COLUMN IF NOT EXISTS review_fee_snapshot INTEGER;
