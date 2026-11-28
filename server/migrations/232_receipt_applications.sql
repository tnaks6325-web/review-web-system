-- 232: 영수증리뷰 3단계 — 신청 ↔ 영수증 한 장 묶기 + 참여일·리뷰마감일 + 리뷰 낸 영수증 표시 (결정 434 · 2026-11-27).
--
-- 리뷰어가 참여하는 순간 **안 쓴 영수증 한 장**이 그 신청에 묶인다(campaign_applications.receipt_pool_id).
--   영수증이 비었는지 = 이 영수증을 가리키는 신청이 「살아 있음」(applied·submitted)이 아니고, 그 영수증으로 리뷰를 낸 적이 없음.
--   그래서 신청 취소·만료·줄 삭제 때 영수증 표(receipt_pool)를 따로 고치지 않는다 — 신청 표가 단일 출처다(예약 228 과 같은 방식).
--   ★ 예외 = 리뷰를 낸 영수증(receipt_pool.reviewed_at) — 그 사람이 뒤에 취소돼도 다른 사람에게 다시 주지 않는다
--     (사용자 확정 2026-11-27: 「리뷰를 이미 냈으면 그 사람 것」 · 네이버 영수증 리뷰는 영수증 한 장에 한 번).
-- ★ 한 영수증에 두 신청이 묶이지 않게 부분 유일 색인(살아 있는 신청만 — 만료·취소된 신청은 영수증을 놓는다).
--   동시 참여가 마지막 한 장을 함께 노려도 색인이 하나만 받는다(넘침 구조적 차단).
-- ★ joined_date · review_deadline = 지금 그 영수증을 가진 참여의 참여일(KST)·리뷰마감일(참여일 + 오더의 N일).
--   배정할 때 같은 트랜잭션에서 새긴다(다시 배정되면 새 참여 값으로 덮는다). 작업표 「참여일자」·「리뷰마감일」 칸과
--   리뷰어 「오늘/내일 마감」·담당자 「마감 지남」(결정 422)이 이 값을 읽는다.
-- ★ 가산 전용 · CHECK/FK 없음(082·137 규율) · 러너가 매 기동 시 재실행하므로 멱등.
-- 롤백: DROP INDEX uq_campaign_apps_receipt_pool; ALTER TABLE campaign_applications DROP COLUMN receipt_pool_id;
--       ALTER TABLE receipt_pool DROP COLUMN reviewed_at, DROP COLUMN review_deadline, DROP COLUMN joined_date;
--   (코드가 먼저 되돌아가 있어야 한다 — 칸이 없으면 기동 필수 스키마 검사가 부팅을 막는다)

ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS receipt_pool_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_receipt_pool
  ON campaign_applications (receipt_pool_id)
  WHERE receipt_pool_id IS NOT NULL AND status IN ('applied', 'submitted');

ALTER TABLE receipt_pool ADD COLUMN IF NOT EXISTS joined_date DATE;
ALTER TABLE receipt_pool ADD COLUMN IF NOT EXISTS review_deadline DATE;
ALTER TABLE receipt_pool ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

COMMENT ON COLUMN campaign_applications.receipt_pool_id IS '영수증리뷰(결정 434) — 이 신청에 배정된 영수증(receipt_pool.id). 다른 종류 신청은 NULL.';
COMMENT ON COLUMN receipt_pool.reviewed_at IS '영수증리뷰(결정 434) — 이 영수증으로 리뷰 캡처가 제출된 때. 있으면 신청이 취소돼도 다시 배정하지 않는다.';
