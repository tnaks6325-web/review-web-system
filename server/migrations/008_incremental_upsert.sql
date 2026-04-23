-- ═══════════════════════════════════════════════════════════
-- Migration 008: Incremental Upsert 지원
-- 
-- 1. review_index에 (sheet_id, tab_name, row_index) 유니크 제약 추가
--    → ON CONFLICT DO UPDATE로 DELETE→INSERT 전체 교체 방지
--    → 인덱스 재구축 비용 대폭 절감
--
-- 2. review_index.row_index NOT NULL 제약 추가 (데이터 정합성)
-- ═══════════════════════════════════════════════════════════

-- row_index가 NULL인 기존 데이터 정리 (혹시 있다면)
DELETE FROM review_index WHERE row_index IS NULL;

-- row_index NOT NULL 제약
ALTER TABLE review_index ALTER COLUMN row_index SET NOT NULL;

-- 중복 행 제거 (같은 sheet_id + tab_name + row_index가 여러 개인 경우 최신 1개만 유지)
DELETE FROM review_index a
  USING review_index b
  WHERE a.sheet_id = b.sheet_id
    AND a.tab_name = b.tab_name
    AND a.row_index = b.row_index
    AND a.built_at < b.built_at;

-- 유니크 제약 추가 (ON CONFLICT 타겟)
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_upsert
  ON review_index (sheet_id, tab_name, row_index);
