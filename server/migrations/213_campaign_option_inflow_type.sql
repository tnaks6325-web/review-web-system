-- 213: 선택지 줄마다 유입방식 (결정 333 · 사용자 확정 2026-11-04 「가」)
-- 한 작업에 상품이 둘 이상이고 상품마다 유입이 다를 때(예: 21호 가이드유입 · 23호 링크유입) 오더·공고를 둘로 쪼개지 않게 —
-- 그 선택지의 유입방식을 줄에 둔다. 'guide' | 'link' | ''(NULL 포함) = 공고 전체 값(work_detail.inflowType)을 따른다.
-- ★ 가산 전용 — 칸을 더하기만 한다. 기존 행 값 변경 0 · 백필 0 · CHECK 0 · 트리거 0 · DROP 0.
--   NULL = 따름 = 종전 동작 그대로(배포 즉시 동작 불변 · 137 규율).
-- 롤백: 코드를 되돌린 뒤 칸 DROP(되돌려도 다른 칸은 영향 없음 · 옛 코드는 이 칸을 읽지 않는다).
ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS inflow_type TEXT NULL;
