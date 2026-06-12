-- 025: participation_links — 제출 시점 리뷰어 신원 확정 기록 (P5)
-- 목적: "참여한 캠페인 조회" 시 시트의 지저분한 이름칸(인애드명≠실명, 수취인 플레이스홀더 등)
--       재매칭에 의존하지 않고, 제출 시점에 확정된 (시트행 ↔ 리뷰어 phone8) 링크로
--       본인 참여를 정확히 식별한다.
-- ※ 구글시트에는 컬럼을 추가하지 않고 DB에만 보관.
-- ※ 인덱스 재빌드(review_index UPSERT)와 독립된 별도 테이블 → 빌드에 절대 덮어쓰이지 않음.
-- ※ migrate.js 는 매 부팅마다 전체 .sql 재실행 → 반드시 idempotent.
CREATE TABLE IF NOT EXISTS participation_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id     TEXT NOT NULL,
  tab_name     TEXT NOT NULL,
  row_index    INTEGER NOT NULL,          -- review_index.row_index 와 동일 (1-based 시트행)
  phone8       TEXT,                       -- 제출 리뷰어 phone8 (검증 세션 우선, 없으면 행 연락처)
  name         TEXT,                       -- 제출 리뷰어 이름 (로그인명 우선)
  source       TEXT DEFAULT 'order_submit',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sheet_id, tab_name, row_index)
);
CREATE INDEX IF NOT EXISTS idx_participation_links_phone8        ON participation_links(phone8);
CREATE INDEX IF NOT EXISTS idx_participation_links_sheet_tab_row ON participation_links(sheet_id, tab_name, row_index);
