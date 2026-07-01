-- 041: 캠페인탭 로스터 DB 원장 (탈-시트 DB-first 이관 Phase 1 · shadow).
-- ★ 가산적·비파괴·기본 무영향: 빈 신규 테이블만 생성. 기존 흐름(검색/my-status/대시보드)은
--   여전히 review_index를 소스로 사용 — 이 테이블은 아직 아무도 소비하지 않는다(shadow).
--   Phase 3에서 env 게이트로 소스를 전환하기 전까지 라이브에 영향 0.
--
-- 목적: 시트가 원본이던 로스터(참여자 명단 + 리뷰제출/입금/차수/옵션/상품)를 DB로 승격하기 위한 그릇.
--   Phase 1 백필은 review_index(이미 시트를 파싱해 둔 DB)에서 복사 → 시트 재읽기 0(쿼터 무소모).

CREATE TABLE IF NOT EXISTS campaign_participants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id       TEXT NOT NULL,
  tab_gid        TEXT,
  tab_name       TEXT NOT NULL,
  campaign_name  TEXT,
  seq            INTEGER NOT NULL,          -- 탭 내 순번(= review_index.row_index). 임포트 멱등키.
  reviewer_name  TEXT,                      -- 인애드명(주문자 계열)
  recipient_name TEXT,                      -- 수취인(있으면)
  phone8         TEXT,                      -- 연락처 끝 8자리(매칭키)
  round          TEXT,                      -- 차수
  option_text    TEXT,                      -- 옵션(정형화 대상)
  product_name   TEXT,
  product_url    TEXT,
  start_date     TEXT,
  end_date       TEXT,
  is_submitted   BOOLEAN NOT NULL DEFAULT FALSE,  -- 리뷰제출(토글 원본)
  submitted_at   TIMESTAMPTZ,
  is_paid        BOOLEAN NOT NULL DEFAULT FALSE,   -- 입금(토글 원본)
  paid_at        TIMESTAMPTZ,
  source         TEXT NOT NULL DEFAULT 'import',   -- import | manual | order
  sheet_row      INTEGER,                   -- 미러 매핑용(Phase 2 시트 출력)
  last_sheet_write_sig TEXT,                -- provenance(order_submissions 방식 재사용)
  row_json       JSONB,                     -- 원본 행 스냅샷(참고)
  imported_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     TEXT,
  deleted_at     TIMESTAMPTZ
);

-- 임포트 멱등: 같은 탭·같은 순번은 1행(재임포트 시 upsert). 시트 자연 행정체성과 일치.
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_seq
  ON campaign_participants (sheet_id, tab_name, seq);

CREATE INDEX IF NOT EXISTS idx_participants_tab
  ON campaign_participants (sheet_id, tab_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_participants_phone8
  ON campaign_participants (phone8) WHERE deleted_at IS NULL;
