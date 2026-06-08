-- 019_work_orders.sql
-- 작업 오더(work_orders): AE(영업담당자) → 리뷰웹시스템 관리자 작업요청 인테이크
-- ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.

CREATE TABLE IF NOT EXISTS work_orders (
  id              TEXT PRIMARY KEY,                    -- 'wo_' + randomBytes(6).hex
  title           TEXT NOT NULL,                       -- 작업명
  start_date      DATE,                                -- 시작일 (빈값은 null 로 저장)
  product_option  TEXT DEFAULT '',                     -- 상품옵션·결제금액 (자유서술)
  pay_amount      INTEGER DEFAULT 0,                   -- 결제금액 (숫자 분리)
  daily_count     INTEGER DEFAULT 0,                   -- 일일진행건수
  purchase_time   TEXT DEFAULT '',                     -- 구매시간대
  inflow_keyword  TEXT DEFAULT '',                     -- 유입키워드
  delivery_type   TEXT DEFAULT '',                     -- 배송유형 (빈박스/실배송)
  courier_proxy   BOOLEAN DEFAULT FALSE,               -- 택배대행여부
  review_type     TEXT DEFAULT '',                     -- 리뷰유형 (전체포토/텍스트20·포토80 등)
  recruit_count   INTEGER DEFAULT 0,                   -- 모집인원
  review_guide    TEXT DEFAULT '',                     -- 리뷰등록가이드
  special_notes   TEXT DEFAULT '',                     -- 특이사항
  product_url     TEXT DEFAULT '',                     -- 상품확인용URL
  work_sheet_url  TEXT DEFAULT '',                     -- 작업시트탭URL (AE 제출 시 필수)
  goods_cost_type TEXT DEFAULT '',                     -- 물건비 (현금/계산서)
  chat_room_url   TEXT DEFAULT '',                     -- 카톡팀채팅방URL (관리자 발행 시 필수)
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','reviewing','await_chatroom','published','done','rejected','revision')),
  created_by      TEXT NOT NULL DEFAULT '',            -- staff username (= JWT name)
  admin_memo      TEXT DEFAULT '',                     -- 반려/보완 사유 등
  processed_by    TEXT DEFAULT '',                     -- 처리 관리자 name
  linked_campaign_id TEXT DEFAULT '',                  -- 다음 단계 모집공고 연계용 (FK 미설정 — 이력 보존)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_status     ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_created_by ON work_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_work_orders_created_at ON work_orders(created_at DESC);
