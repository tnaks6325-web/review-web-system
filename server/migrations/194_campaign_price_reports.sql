-- 194: 리뷰어 가격 신고 + 관리자 전원 팝업 + 금액 수정 이력 (결정 266 · 사용자 확정 2026-10-20)
--   리뷰어가 "화면과 가격이 달라요"로 주문을 취소하면 가격 신고로 센다. 다른 리뷰어 2명이면 관리자 전원에게 팝업.
--   팝업에서 [금액 고치기] / [금액 맞음 — 그대로 두기] / [결정 보류] — 처리한 결과가 곧 수정 이력이다.
--   ① 가격 신고 원장 — 취소한 주문 1건 = 1행(같은 주문 두 번 세지 않는다). cleared_at 이 찍히면 그 묶음은 끝.
--   ② 관리자 알림 — 상품(공고+상품명)마다 열린 알림은 하나(부분 유일 색인). 처리되면 resolved_at · resolution · 금액 전후.
--   ★ 품절(184)과 표를 나눈다 — 품절 멈춤·다시 열기가 상품의 열린 알림을 전부 닫으므로, 같은 표에 두면
--     품절 처리 한 번에 가격 알림이 아무도 모르게 닫힌다.
--   ★ 추가만 하는 변경 — 기존 칸·행을 바꾸지 않는다.
CREATE TABLE IF NOT EXISTS campaign_price_reports (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  opt_key TEXT NOT NULL DEFAULT '',          -- '' = 상품을 나누지 않은 공고(공고 전체)
  order_submission_id TEXT NOT NULL,
  reporter TEXT NOT NULL DEFAULT '',         -- 리뷰어 전화 끝 8자리(다른 리뷰어인지 가리는 데만 쓴다)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_reports_order ON campaign_price_reports (order_submission_id);
CREATE INDEX IF NOT EXISTS idx_price_reports_open
  ON campaign_price_reports (campaign_id, opt_key) WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS campaign_price_alerts (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  opt_key TEXT NOT NULL DEFAULT '',
  report_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',       -- 'edited' | 'kept' | 'deferred' | 'gone'
  old_amount INT NULL,                       -- 처리할 때의 공고 금액(1건당)
  new_amount INT NULL                        -- 'edited' 일 때 고친 금액
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_alerts_open
  ON campaign_price_alerts (campaign_id, opt_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_price_alerts_campaign_resolved
  ON campaign_price_alerts (campaign_id, resolved_at DESC) WHERE resolved_at IS NOT NULL;
