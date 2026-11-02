-- 209: 주문의 캡처 확인 🚩 — 사용자 확정 2026-11-02 (결정 319).
--
-- 구매캡처의 결제금액이 공고 금액과 다른데(쿠팡 30% 초과 → 직원 확인 요청 · 쿠팡 밖 1,000원 초과 → 리뷰어 확인 후 제출),
-- 또는 AI 가 캡처에서 다른 상품·개수를 읽었는데 리뷰어가 「고른 것이 맞다」고 답해 받은 주문을 작업보드 🚩 로 남긴다.
--   order_submissions.capture_flags  NULL = 해당 없음 · {"flags":[{"code":"price_over|price_diff|product_differs|qty_differs", ...}]}
-- ★ 가산 전용 · 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다. 옛 주문은 NULL(= 무변화).
-- 롤백: DROP COLUMN(코드가 먼저 되돌아가 있어야 한다).

ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS capture_flags JSONB NULL;
