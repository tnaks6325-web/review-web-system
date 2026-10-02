-- 172_review_photo_relinks.sql
-- 리뷰 사진 줄 재연결 이력 (2026-10-02 · 결정 186 별건 "리뷰 사진이 다른 사람 줄에 붙어 있다")
--
-- 왜: 시트 시절(5~8월) 줄 삽입·삭제·정렬로 사람은 새 행 번호로 갔는데 review_submissions.row_index·
--     review_inspections.row_index·review_index.review_file_id 는 옛 번호에 남았다. 재연결 도구
--     (reviewPhotoRelink.service)가 사진을 옮길 때 **바꾸기 전 값**을 여기에 남겨 되돌릴 수 있게 한다.
-- ★ 가산적: 새 표 1개뿐. 기존 표·칸은 건드리지 않는다.
-- ★ 개인정보 최소: 이름·파일명은 담지 않는다(파일 id·행 번호·대표 이미지 id 만).
-- 되돌리기: DROP TABLE IF EXISTS review_photo_relinks;  (도구가 쓰기 전이면 무영향)

CREATE TABLE IF NOT EXISTS review_photo_relinks (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              TEXT        NOT NULL,
  sheet_id            TEXT        NOT NULL,
  tab_name            TEXT        NOT NULL,
  rs_id               UUID        NOT NULL,   -- review_submissions.id (FK 미사용 — 행이 지워져도 이력은 남는다)
  file_id             TEXT        NOT NULL,
  from_row            INTEGER     NOT NULL,
  to_row              INTEGER     NOT NULL,
  from_review_index_id UUID,                  -- 옮기기 전 rs.review_index_id
  from_rep_before     TEXT,                   -- 출발 줄 review_index.review_file_id (적용 직전)
  to_rep_before       TEXT,                   -- 도착 줄 review_index.review_file_id (적용 직전)
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at         TIMESTAMPTZ,
  reverted_by         TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_photo_relinks_run ON review_photo_relinks (run_id);
CREATE INDEX IF NOT EXISTS idx_review_photo_relinks_file ON review_photo_relinks (file_id);
CREATE INDEX IF NOT EXISTS idx_review_photo_relinks_tab ON review_photo_relinks (sheet_id, tab_name);
