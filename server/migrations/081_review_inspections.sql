-- ═══════════════════════════════════════════════════════════
-- 081: 리뷰 자동검수 (M1 — 데이터 기반 + 2차 인라인 검수)
--
-- 배경: 리뷰 캡처는 지금까지 "슬롯 형식이 맞는가"(리뷰/영수증)만 보고 통과시켰다.
--   ① 우리 상품 리뷰가 맞는지 ② 같은 파일 재탕인지 ③ 본문 복붙인지는
--   아무도 검사하지 않아, 업체에 전달된 뒤 사람이 발견하는 구조였다.
--
-- 비파괴: 신규 테이블 1개 + 기존 테이블 컬럼 추가만. 되돌리기 = 이 파일 드롭.
--   ※ migrate.js 는 적용이력 없이 매번 전체 .sql 을 재실행하므로 반드시 idempotent.
-- ═══════════════════════════════════════════════════════════

-- ① 제출 원장에 파일 지문(중복 판정용).
--    업로드 시점에 base64 를 이미 쥐고 있으므로 계산 비용이 사실상 0 —
--    과거분은 배치(M2)가 Drive 에서 내려받아 백필한다.
ALTER TABLE review_submissions ADD COLUMN IF NOT EXISTS file_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_review_sub_hash ON review_submissions(file_hash)
  WHERE file_hash IS NOT NULL;

-- ② 탭별 기대 상품명(줄바꿈 구분 복수 허용).
--    작업오더에 상품명이 없거나 시트 표기와 다를 때 관리자가 직접 적는 칸.
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS inspect_product_names TEXT DEFAULT '';

-- ③ 검수 결과 원장 — 파일 1장 = 1행.
--    ★ 판정 결과를 review_submissions 에 직접 쓰지 않는다: 그 테이블은 제출 원장이라
--      검수가 실패해도 제출 기록은 온전해야 하고, 재검수로 값이 바뀌는 컬럼을
--      섞으면 "제출됐는가"와 "검수됐는가"가 한 행에서 엉킨다.
CREATE TABLE IF NOT EXISTS review_inspections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         TEXT NOT NULL,             -- review_submissions.file_id (유니크)
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  row_index       INTEGER,
  reviewer_name   TEXT,
  slot_key        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
                  -- pending(미검수) | pass | suspect(의심) | fail(확실 불량)
                  -- | unverifiable(판정 불가) | resolved(관리자 확인 종결)
  checks          JSONB DEFAULT '{}'::jsonb, -- 항목별 판정 상세(format/product/duplicate/similarity/author)
  channel         TEXT,                      -- coupang | naver | kakao | oliveyoung (판별 결과)
  device          TEXT,                      -- pc | mobile (기록만 — 대조에 쓰지 않음)
  ocr_product     TEXT,                      -- 이미지 속 상품명 표기
  ocr_text        TEXT,                      -- 리뷰 본문 전문 (유사도 재료)
  ocr_author      TEXT,                      -- 작성자 마스킹 표기 (수집만 — 판정 안 함)
  file_hash       TEXT,
  ai_confidence   REAL,
  attempts        INTEGER DEFAULT 0,         -- 재시도 상한(무한 재시도 금지)
  inspected_at    TIMESTAMPTZ,               -- AI 판정 완료 시각
  resolved_at     TIMESTAMPTZ,               -- 관리자 확인 시각
  resolved_by     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 파일 단위 업서트(재업로드·재검수 안전)
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_inspect_file ON review_inspections(file_id);
-- 탭별 검수 현황 조회(관리자 검수 탭 — M3)
CREATE INDEX IF NOT EXISTS idx_review_inspect_tab
  ON review_inspections(sheet_id, tab_name, status);
-- 손볼 것만 빠르게 — 통과 건은 인덱스에 넣지 않는다(대부분이 통과)
CREATE INDEX IF NOT EXISTS idx_review_inspect_open
  ON review_inspections(status, created_at DESC)
  WHERE status IN ('pending', 'suspect', 'fail');
-- 본문 유사도 대조(같은 탭 안에서 비교) — pg_trgm 은 migration 004 에서 이미 설치됨
CREATE INDEX IF NOT EXISTS idx_review_inspect_text_trgm
  ON review_inspections USING GIN (ocr_text gin_trgm_ops);
