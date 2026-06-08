-- 인트라넷 intake 정밀 매핑용 보강 컬럼
-- daily_count_text: 일일 진행건수 범위(예: "3~7건") 보존 (daily_count 정수는 최소값/대표값)
-- product_options_json: 상품/옵션 구조화 데이터(JSON 문자열) — 표/필터/통계용 (product_option 요약은 그대로 유지)
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS daily_count_text     TEXT DEFAULT '';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS product_options_json TEXT DEFAULT '';
