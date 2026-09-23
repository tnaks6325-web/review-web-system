-- 143_trackb_workdesk_advertiser_order.sql
-- 작업보드 상단 업체목록의 개인별 좌우 배치. 즐겨찾기와 달리 순서 자체가 사용자 결정이므로
-- 별도 원장에 배열 그대로 보관한다. 로그아웃·세션만료·다른 브라우저 로그인 뒤에도 복원된다.
CREATE TABLE IF NOT EXISTS trackb_workdesk_advertiser_order (
  owner_key       TEXT PRIMARY KEY,
  advertiser_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
