-- 135 · 배송유형 5종화(실배송·빈박스·택배발송대행·회수·혼합) — 회수·혼합의 부속정보 구조화
--
-- ★★ 인트라넷 리뷰오더는 배송유형을 `delivery_type` **한 칸에 문장으로 접어** 보낸다:
--      회수(회수택배사: CJ대한통운, 회수상품명칭: OO선크림 30ml)
--      혼합(실배송 20건, 빈박스 80건)
--    리뷰웹 판정은 전부 정확일치라 문장이 오면 빗나갔고, 회수·혼합 오더는 접수만 되고
--    작업표 열도 안 켜지고 모집공고 프리필에서 값이 사라졌다(2026-08-24 조사).
--
-- ★ **컬럼 추가만 · 백필 0 · CHECK 0** = 배포 즉시 동작 불변.
--   기존 문장은 그대로 두고 `utils/deliveryType` 이 읽을 때 파싱한다(과거 오더 소급 구제).
--   이 컬럼들은 인트라넷 구조화 전송이 붙으면 채워지는 **우선 재료**다(문장 파싱은 폴백).
--
-- ★ 타입은 전부 TEXT/JSONB — `recruit_campaigns.id` 가 TEXT 인 이 레포의 FK 타입 규율과
--   무관한 단순 컬럼 추가라 42804 계열 위험 없음.

ALTER TABLE work_orders       ADD COLUMN IF NOT EXISTS delivery_type_mix JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_orders       ADD COLUMN IF NOT EXISTS recall_courier    TEXT  NOT NULL DEFAULT '';
ALTER TABLE work_orders       ADD COLUMN IF NOT EXISTS recall_product    TEXT  NOT NULL DEFAULT '';

ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS delivery_type_mix JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS recall_courier    TEXT  NOT NULL DEFAULT '';
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS recall_product    TEXT  NOT NULL DEFAULT '';
