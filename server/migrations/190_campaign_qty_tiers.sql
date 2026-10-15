-- 190: 인당 구매수량 단계 — 모집공고 쪽 단계 표 + 참여·주문의 고른 개수 (구매수량 ③-가, 결정 253 · 2026-10-15)
--
-- 작업오더 상품 구성의 qty_tiers(결정 250)를 공고 발행 때 이 표로 복사한다(오더 단계는 접수 뒤 잠겨 바뀌지 않는다 → 스냅샷).
--   opt_key NULL = 그 상품의 모든 옵션이 함께 쓰는 단계(common) / 값 = 그 옵션 전용 단계(by_option).
--   마감은 사람 수(people)로 센다 — 판매 개수는 qty × 사람 수.
-- campaign_applications / order_submissions 의 purchase_qty · qty_tier_amount = 그 사람이 고른 개수 · 그 단계 1인 결제금액.
--   NULL = 단계 없는 공고(종전 = 1개). 가산 칸만 추가 — 기존 쓰기 경로 무변경. 백필 없음.
-- 롤백: DROP TABLE IF EXISTS campaign_qty_tiers;
--       ALTER TABLE campaign_applications DROP COLUMN IF EXISTS purchase_qty, DROP COLUMN IF EXISTS qty_tier_amount;
--       ALTER TABLE order_submissions DROP COLUMN IF EXISTS purchase_qty, DROP COLUMN IF EXISTS qty_tier_amount;
CREATE TABLE IF NOT EXISTS campaign_qty_tiers (
  id           SERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL DEFAULT '',
  opt_key      TEXT,
  qty          INT  NOT NULL CHECK (qty BETWEEN 1 AND 99),
  people       INT  NOT NULL CHECK (people >= 0),
  pay_amount   INT  NOT NULL CHECK (pay_amount >= 0),
  buy_method   TEXT NOT NULL DEFAULT 'qty' CHECK (buy_method IN ('qty', 'option')),
  sort_order   INT  NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_qty_tiers
  ON campaign_qty_tiers (campaign_id, product_name, COALESCE(opt_key, ''), qty);
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS purchase_qty INT;
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS qty_tier_amount INT;
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS purchase_qty INT;
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS qty_tier_amount INT;
