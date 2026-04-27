-- 010: 차수 단위 마감 지원
-- tab_configs에 closed_rounds 컬럼 추가 (쉼표 구분 차수값: "1차,2차")
-- 기존 is_closed=TRUE 이고 차수가 있는 경우, 전체 마감으로 유지
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS closed_rounds TEXT DEFAULT '';
