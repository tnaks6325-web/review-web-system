-- 016: tab_configs에 distinct_values_cache 컬럼 추가
-- 옵션 상품명 등의 고유값(distinctValues)을 미리 캐시하여 즉시 응답
-- 구조: { "1-4차": { "상품명": ["인디아드 여성용 끈나시 3p"] }, "1-3차": { "상품명": [...] } }

ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS distinct_values_cache JSONB DEFAULT '{}';
