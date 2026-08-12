-- 103: 인트라넷 광고주를 리뷰웹의 광고주/포털 작업과 1:1 원본으로 연결한다.
--
-- 이름은 표시값일 뿐 병합 키가 아니다. intranet_advertiser_id 만 자동 연결의
-- 근거로 사용하며, 포털 작업은 work_order_id 하나당 하나만 존재한다.

ALTER TABLE advertisers
  ADD COLUMN IF NOT EXISTS intranet_advertiser_id TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS intranet_contact TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS intranet_business_number TEXT DEFAULT '';

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS advertiser_id TEXT DEFAULT '';

ALTER TABLE portal_works
  ADD COLUMN IF NOT EXISTS work_order_id TEXT DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_advertisers_intranet_advertiser_id
  ON advertisers (intranet_advertiser_id)
  WHERE intranet_advertiser_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_works_work_order_id
  ON portal_works (work_order_id)
  WHERE work_order_id <> '';

CREATE INDEX IF NOT EXISTS idx_work_orders_advertiser_id
  ON work_orders (advertiser_id)
  WHERE advertiser_id <> '';
