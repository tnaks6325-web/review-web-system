-- 134: 복합 작업(옵션 있는 상품 + 옵션 없는 상품)의 "선택 단위"와 선택지별 유입가이드
--
-- 배경: 한 작업에 상품A(옵션 2개) + 상품B(옵션 없음)가 함께 있을 때
--   ① 리뷰어의 참여 선택지는 3가지(A-옵션1 / A-옵션2 / B)이고
--   ② 가이드유입이면 그 3가지가 각각 다른 유입가이드를 봐야 한다.
-- 종전 모델은 "옵션"만 선택 단위였고 유입가이드는 공고당 한 벌(work_detail.inflowGuideHtml)뿐이라
-- 두 가지 모두 표현할 수 없었다.
--
-- 모델: 선택 단위 = campaign_options 행 하나.
--   unit_kind='option'  → 상품의 옵션(종전 그대로)
--   unit_kind='product' → 옵션 없는 상품 자체가 하나의 선택 단위
--   product_name        → 그 단위가 속한 상품명(리뷰어 선택 화면의 묶음 머리)
--   inflow_guide_html / inflow_guide_images → 그 선택지 전용 유입가이드(비면 공고 공통 가이드로 접힌다)
--
-- ★ 컬럼 추가만 · 백필 0 · CHECK 0 · FK 0 (082 의 42804 사고 규율).
--   기본값이 종전 동작과 같아 배포 즉시 동작 불변(opt-in):
--     unit_kind='option' = 지금까지의 모든 행 · 가이드 빈 값 = 공고 공통 가이드 사용.
ALTER TABLE campaign_options
  ADD COLUMN IF NOT EXISTS product_name         TEXT  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS unit_kind            TEXT  NOT NULL DEFAULT 'option',
  ADD COLUMN IF NOT EXISTS inflow_guide_html    TEXT  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS inflow_guide_images  JSONB NOT NULL DEFAULT '[]'::jsonb;
