-- 145: 실제 주문 상품명·참여 이력은 보존하고, 작업보드에서만 쓸 짧은 표시명을 탭 단위로 둔다.
-- 빈 문자열은 "별칭 없음"으로서 기존 상품명 표시로 폴백한다.
ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS workboard_display_name TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN tab_configs.workboard_display_name IS
  '작업보드 내부/업체 뷰와 작업조건에만 쓰는 상품 표시 별칭. 주문·참여 원본 상품명은 변경하지 않는다.';
