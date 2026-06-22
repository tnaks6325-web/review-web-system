-- ═══════════════════════════════════════════════════════════
-- 032: 리뷰 제출 이미지 원장 테이블 (A-2)
--
-- 배경: review_index의 review_file_* 컬럼(031, A-1)은 "행당 대표 1장"만
--   담는다. 한 제출에 여러 장이거나 재제출 이력이 있으면 전수 추적이 안 된다.
--   → 업로드된 리뷰 이미지를 파일 단위로 모두 기록하는 원장 테이블을 둔다.
--   (탭/행/리뷰어/Drive 파일ID/제출시각/출처)
--
-- 비파괴적: 신규 테이블 생성만. file_id 유니크로 업서트(재실행/재업로드 안전).
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS review_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  tab_gid         TEXT,
  row_index       INTEGER,                 -- 매칭된 인덱스 행 번호 (모호/미매칭 시 NULL)
  reviewer_name   TEXT,                    -- 파일명/업로드에서 추출한 리뷰어 이름
  review_index_id UUID,                    -- review_index.id (결정적 매칭 시에만 채움)
  file_id         TEXT NOT NULL,           -- Drive 파일 ID
  file_url        TEXT,                    -- 보기 링크
  file_name       TEXT,                    -- 파일명
  source          TEXT DEFAULT 'upload',   -- 'upload' | 'backfill'
  uploaded_at     TIMESTAMPTZ,             -- 제출(파일 생성) 시각
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_sub_file     ON review_submissions(file_id);
CREATE INDEX IF NOT EXISTS idx_review_sub_row            ON review_submissions(sheet_id, tab_name, row_index);
CREATE INDEX IF NOT EXISTS idx_review_sub_reviewer       ON review_submissions(sheet_id, tab_name, reviewer_name);
CREATE INDEX IF NOT EXISTS idx_review_sub_index          ON review_submissions(review_index_id);
