-- 051: Track B 작업오더(발주)↔탭 링크 — Track B 전용 소유 테이블(advertiser_campaigns와 동일 격리 패턴).
--   ★ 왜 별도 테이블인가(Track A 무접촉): work_orders.linked_tab_* 는 order.routes 승인(accept) 흐름이
--     읽어 동작을 분기한다(비적격 상태+linked_tab 설정 시 승인 멱등 skip, idempotent 판정). 그래서 Track B가
--     그 컬럼을 쓰면 라이브 승인 동작이 바뀔 수 있다 → work_orders 를 절대 건드리지 않고 여기 링크를 저장한다.
--   가산적·비파괴. 되돌리기 = DROP TABLE. 부팅 전량 재실행 idempotent.
CREATE TABLE IF NOT EXISTS trackb_work_order_links (
  id            BIGSERIAL PRIMARY KEY,
  sheet_id      TEXT NOT NULL,
  tab_name      TEXT NOT NULL,
  work_order_id TEXT NOT NULL,          -- work_orders.id (읽기 참조만, FK 미설정 = 삭제순서/부팅 안전)
  linked_by     TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
-- 탭당 활성 링크 1개(교체 시 upsert). 소프트삭제로 되돌리기.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_wo_link_active
  ON trackb_work_order_links (sheet_id, tab_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trackb_wo_link_wo
  ON trackb_work_order_links (work_order_id) WHERE deleted_at IS NULL;
