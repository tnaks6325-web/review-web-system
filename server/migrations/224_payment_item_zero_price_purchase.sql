-- 결정 376(사용자 확정 2026-11-16): 일반(우리 은행) 작업의 「0원 구매 · 리뷰비만」 입금 항목 표시.
-- 리뷰어가 0원에 구매한 줄은 회차 항목이 제품비 0 · 금액 = 리뷰비로 박제된다 — 결정 292 「리뷰비만 보낸 건」(isFeeOnlyItem)과 모양이 같다.
-- 이 표시가 있는 항목은 그 판정에서 빠져 입금일 기록·PAID·리뷰어 입금 완료 표시가 일반 입금과 같게 동작한다(Q&A 의 is_qna 와 같은 방식).
-- is_qna 를 재사용하지 않는 이유: 리뷰 작업을 Q&A 로 적게 되어 칸 이름과 뜻이 어긋난다.
-- 기존 항목은 FALSE(종전 동작 그대로).
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS zero_price_purchase BOOLEAN NOT NULL DEFAULT FALSE;
