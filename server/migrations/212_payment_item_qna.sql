-- 결정 321 4단계: Q&A체험단 입금 항목 표시.
-- Q&A 는 상품을 사지 않아 회차 항목이 제품비 0 · 금액 = 참여비로 박제된다 — 결정 292 「리뷰비만 보낸 건」(isFeeOnlyItem)과 모양이 같다.
-- 이 표시가 있는 항목은 그 판정에서 빠져 입금일 기록·PAID·리뷰어 입금 완료 표시가 일반 입금과 같게 동작한다.
-- 기존 항목은 FALSE(종전 동작 그대로).
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS is_qna BOOLEAN NOT NULL DEFAULT FALSE;
