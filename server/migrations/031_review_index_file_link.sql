-- ═══════════════════════════════════════════════════════════
-- 031: 인덱스 행 ↔ 제출된 리뷰 이미지(Drive 파일) 결정적 연결 (A-1)
--
-- 배경: 지금까지 review_index(인덱스)는 "어느 행의 리뷰가 제출됐다"는
--   is_submitted 불리언만 기록하고, 그 제출의 리뷰 이미지가 어느 Drive
--   파일인지는 어디에도 저장하지 않았다. 그 결과 파일이 [리뷰] 폴더가 아닌
--   루트로 새도 인덱스 행과 결정적으로 매칭할 방법이 없었다.
--   → 제출된 리뷰 파일의 Drive ID/URL을 해당 인덱스 행에 저장한다.
--
-- 비파괴적: 컬럼 추가만, 기존 행은 NULL/0으로 시작.
--   (행당 대표 1장 + 개수. 다중 파일·재제출 이력은 032(review_submissions)에서 처리)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE review_index ADD COLUMN IF NOT EXISTS review_file_id    TEXT;          -- 대표 리뷰 이미지 Drive 파일 ID
ALTER TABLE review_index ADD COLUMN IF NOT EXISTS review_file_url   TEXT;          -- 대표 리뷰 이미지 보기 링크
ALTER TABLE review_index ADD COLUMN IF NOT EXISTS review_file_name  TEXT;          -- 대표 리뷰 이미지 파일명
ALTER TABLE review_index ADD COLUMN IF NOT EXISTS review_file_count INTEGER DEFAULT 0; -- 연결된 리뷰 이미지 수
ALTER TABLE review_index ADD COLUMN IF NOT EXISTS review_file_at    TIMESTAMPTZ;   -- 연결(업로드/백필) 시각

CREATE INDEX IF NOT EXISTS idx_review_file_id ON review_index(review_file_id);
