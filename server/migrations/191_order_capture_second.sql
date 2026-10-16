-- 191: 구매캡처 두 번째 장 (결정 255 · 사용자 확정 2026-10-16 "모두 권장")
--
-- 아이폰 등은 구매내역이 한 화면에 다 담기지 않아(배송메세지가 잘림) 리뷰어가 두 장으로 나눠 찍는다.
-- 첫 장(capture_file_id)은 종전 그대로 두고, 두 번째 장만 따로 담는다(선택 · 없으면 NULL = 종전 동작).
-- 연결 규칙은 첫 장과 같다 — 구매양식 제출 세션 + 주문 ID 정확일치, 주문 단위 잠금, 먼저 연결된 파일이 이긴다.
-- 가산 칸만 추가(기존 쓰기 경로 무변경). 롤백: ALTER TABLE order_submissions DROP COLUMN IF EXISTS capture_file_id_2,
--   DROP COLUMN IF EXISTS capture2_uploaded_at;
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS capture_file_id_2 TEXT;
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS capture2_uploaded_at TIMESTAMPTZ;
