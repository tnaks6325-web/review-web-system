-- 187: 바로 구매 규칙 위반 표시 (결정 242 · 사용자 확정 2026-10-14 "2.가 — 표시만")
--
-- 공고 참여 없이 바로 낸 구매(order_submissions.campaign_application_id IS NULL)가 들어온 직후, 서버가 공고 참여 규칙
-- (참여권 없는 인기 공고 구매 · 미등록 번호 · 재구매 기간 · 1인 1회 다른 명의 · 하루 상한)을 판정해 결과를 남긴다.
-- NULL = 판정 안 함(공고 참여 주문 · 공고 없는 작업표 · 이 칸 이전 주문 · 판정 실패) / '[]' = 판정했고 위반 없음 /
-- '[{"code":"popular_no_credit"}, …]' = 위반. 막지 않는다 — 입금 여부는 담당자가 정한다.
-- 가산 칸만 추가(기존 쓰기 경로 무변경). 롤백: ALTER TABLE order_submissions DROP COLUMN IF EXISTS rule_flags;
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS rule_flags JSONB;
