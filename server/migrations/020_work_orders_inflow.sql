-- 작업 오더: 유입키워드 → 유입방식(유입가이드/링크유입) + 유입가이드(텍스트·이미지) 전환
-- 기존 inflow_keyword 컬럼은 호환을 위해 유지하고, 신규 컬럼을 추가한다.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS inflow_type  TEXT DEFAULT '';  -- 'guide' | 'link'
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS inflow_guide TEXT DEFAULT '';  -- 유입가이드 본문(HTML, <img> 포함)
