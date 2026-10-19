-- 192: 공고별 필수 배송메세지 + 주문의 배송메세지 확인 결과 — 사용자 확정 2026-10-19 (결정 260).
--
-- 작업 안내에 "배송메세지 00 넣어서 구매"가 있는 공고는, 구매캡처에서 AI 가 읽은 배송메세지(188 delivery_memo)에
-- 그 글자가 들어 있어야 구매양식을 받는다. 없으면 제출을 막고 다시 캡처하게 하며, 두 번째부터는
-- "직원 확인 요청"으로 받되 작업보드에 🚩 로 남겨 직원이 보고 반려(주문 취소)한다.
--   recruit_campaigns.required_delivery_memo  ''=확인 안 함(기존 동작) · 그 외=캡처 배송메세지에 들어 있어야 하는 글자
--   order_submissions.delivery_memo_check     ''=해당 없음 · 'ok'=확인됨 · 'staff_review'=확인 안 된 채 직원 확인 요청으로 받음
-- ★ 가산 전용 · 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다. 옛 공고·옛 주문은 '' (= 무변화).
-- 롤백: 두 칸을 DROP COLUMN(코드가 먼저 되돌아가 있어야 한다).

ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS required_delivery_memo TEXT NOT NULL DEFAULT '';
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS delivery_memo_check TEXT NOT NULL DEFAULT '';
