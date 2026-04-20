-- ============================================================
-- Phase 7: 검색 성능 최적화 — pg_trgm 한글 유사검색 강화
-- ============================================================
-- 기존: reviewer_name ILIKE '%홍길동%' → 풀 테이블 스캔
-- 개선: pg_trgm GIN 인덱스 → 트라이그램 기반 빠른 패턴 매칭
-- ============================================================

-- 1. pg_trgm 확장 활성화 (한글 3-gram 분해 지원)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. review_index.reviewer_name에 GIN trigram 인덱스
-- ILIKE '%검색어%' 쿼리가 이 인덱스를 자동으로 사용
DROP INDEX IF EXISTS idx_review_name_like;  -- 기존 B-tree 인덱스 제거 (ILIKE '%...%'에 무용)
CREATE INDEX IF NOT EXISTS idx_review_name_trgm
  ON review_index USING GIN (reviewer_name gin_trgm_ops);

-- 3. review_index.campaign_name에도 GIN trigram 인덱스 (캠페인명 검색용)
CREATE INDEX IF NOT EXISTS idx_review_campaign_trgm
  ON review_index USING GIN (campaign_name gin_trgm_ops);

-- 4. reviewers.name에 GIN trigram 인덱스 (리뷰어 조회용)
CREATE INDEX IF NOT EXISTS idx_reviewers_name_trgm
  ON reviewers USING GIN (name gin_trgm_ops);

-- 5. tab_configs.campaign_name에 GIN trigram 인덱스
CREATE INDEX IF NOT EXISTS idx_tab_campaign_trgm
  ON tab_configs USING GIN (campaign_name gin_trgm_ops);

-- 6. 복합 조건 최적화: is_submitted + reviewer_name 부분인덱스
-- 가장 빈번한 검색: is_submitted=FALSE AND reviewer_name ILIKE '%...'
CREATE INDEX IF NOT EXISTS idx_review_active_name_trgm
  ON review_index USING GIN (reviewer_name gin_trgm_ops)
  WHERE is_submitted = FALSE;

-- 7. 유사도 임계값 설정 (기본 0.3 → 한글은 낮게 설정 권장)
-- 이 설정은 세션 단위이므로 쿼리 실행 전에 SET해야 함
-- 참고용 주석: SELECT set_limit(0.1);
