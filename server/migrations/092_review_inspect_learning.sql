-- 092: 리뷰검수 수동 확인 = AI 판별 학습 재료
--   ① review_inspections.resolution — 확인 처리를 [정상(오탐)]/[불량 맞음] 두 갈래로 기록.
--      사람의 판단이 원장에 남아 오탐률 관측·상품명 별칭 학습·판별 예시 승격의 원천 신호가 된다.
--   ② tab_configs.inspect_product_aliases — [정상] 처리에서 자동 축적되는 "인정 상품명 별칭"
--      (개행 구분 목록). ★ 기대 상품명(inspect_product_names)과 분리하는 이유:
--      manual 값이 생기면 작업오더 파생 후보가 꺼지는 우선순위 규칙이 있어, 별칭을 거기에
--      섞으면 후보가 좁아진다 — 별칭은 어느 소스든 **가산만** 한다(loadTabExpectations 병합).

ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS resolution TEXT;
COMMENT ON COLUMN review_inspections.resolution IS '사람 확인 결과: ok(정상 — AI 오탐) | bad(불량 맞음) | NULL(구분 없이 확인된 옛 건)';

ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS inspect_product_aliases TEXT;
COMMENT ON COLUMN tab_configs.inspect_product_aliases IS '리뷰검수 [정상] 처리에서 학습된 인정 상품명 별칭(개행 구분) — 기대 상품명에 가산 병합';
