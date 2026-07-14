-- 044: 컬럼감지 provenance (컬럼 판정 DB화 1단계 — 관측성)
-- 가산적·idempotent. 어떤 로직도 바꾸지 않는다 — 빌더가 "어느 칸을 어떤 근거(db매핑/키워드)로 골랐는지"와
-- DB매핑이 재앵커/범위가드로 거부된 내역(드리프트)을 기록만 한다.
--   detect_source: { headerRow, <field>: { col, header, src: 'db'|'keyword'|'none' } }
--   detect_drift:  [ { field, reason: 'range'|'reanchor', storedCol, storedHeader, currentHeader } ] (없으면 NULL)
ALTER TABLE index_master
  ADD COLUMN IF NOT EXISTS detect_source JSONB,
  ADD COLUMN IF NOT EXISTS detect_drift  JSONB,
  ADD COLUMN IF NOT EXISTS detected_at   TIMESTAMPTZ;
