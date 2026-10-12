-- 184: 상품 품절 일시 멈춤 + 리뷰어 품절 신고 + 관리자 전원 팝업 (결정 229 · 사용자 확정 2026-10-12)
--   ① campaign_options 에 멈춤 칸 3개 — 상태(status)와 **따로** 둔다.
--      status 에 'paused' 를 넣으면 공고 수정 창이 active/closed 만 저장해 저장 한 번에 멈춤이 조용히 풀린다.
--      paused_at IS NULL = 열림(종전과 같음 — 기존 행 동작 불변).
--   ② 품절 신고 원장 — 리뷰어가 "품절이라 구매하지 못했어요"로 취소한 주문 1건 = 1행(같은 주문 두 번 세지 않는다).
--      cleared_at 이 찍히면 그 묶음은 끝(다시 열거나 "품절 아님"으로 정리한 뒤부터 새로 센다).
--   ③ 관리자 알림 — 상품(공고+상품명)마다 열린 알림은 하나(부분 유일 색인). 처리되면 resolved_at.
--   ★ 추가만 하는 변경 — 기존 칸·행을 바꾸지 않는다.
ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ NULL;
ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS paused_reason TEXT NOT NULL DEFAULT '';   -- 'manual' | 'auto_soldout'
ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS paused_by TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS campaign_option_soldout_reports (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  opt_key TEXT NOT NULL DEFAULT '',          -- '' = 상품을 나누지 않은 공고
  order_submission_id TEXT NOT NULL,
  reporter TEXT NOT NULL DEFAULT '',         -- 리뷰어 전화 끝 8자리(다른 리뷰어인지 가리는 데만 쓴다)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_option_soldout_reports_order ON campaign_option_soldout_reports (order_submission_id);
CREATE INDEX IF NOT EXISTS idx_option_soldout_reports_open
  ON campaign_option_soldout_reports (campaign_id, opt_key) WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS campaign_option_alerts (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  opt_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                        -- 'soldout_report'(신고만) | 'auto_paused'(신고 2명 → 자동 멈춤)
  report_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT ''        -- 'reopened' | 'kept_paused' | 'paused' | 'not_soldout' | 'gone'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_option_alerts_open
  ON campaign_option_alerts (campaign_id, opt_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_option_alerts_open_created
  ON campaign_option_alerts (created_at DESC) WHERE resolved_at IS NULL;

-- ④ 180 트리거에 멈춤을 더한다 — 어제 상품이 멈춰서 못 채운 인원을 "어제 부족" 팝업이 따로 묻지 않게(그날 규칙이 바뀐 공고).
--    ★ 잠금 순서: 멈춤 쓰기는 공고 행을 먼저 잠근 뒤 상품 행을 고친다(180 주석의 순서와 같다).
DROP TRIGGER IF EXISTS campaign_options_rules_changed_upd ON campaign_options;
CREATE TRIGGER campaign_options_rules_changed_upd
  AFTER UPDATE OF status, daily_limit, recruit_total, opt_key, paused_at ON campaign_options
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.daily_limit IS DISTINCT FROM NEW.daily_limit
     OR OLD.recruit_total IS DISTINCT FROM NEW.recruit_total OR OLD.opt_key IS DISTINCT FROM NEW.opt_key
     OR OLD.paused_at IS DISTINCT FROM NEW.paused_at)
  EXECUTE FUNCTION trg_campaign_options_rules_changed();
