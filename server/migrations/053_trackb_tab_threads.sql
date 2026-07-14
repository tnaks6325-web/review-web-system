-- 053: Track B 탭 스레드(협업 코멘트 + 확인요청 + 내부 메모 통합) — 격리·가산·비파괴.
--   되돌리기 = DROP TABLE. Track A/인트라넷 무접촉(리뷰 PG 신규 테이블만).
--   ② 협업(브랜드사 확인요청·양사 코멘트) + ③ 탭별 내부 메모를 한 타임라인으로:
--     kind='comment'|'request', internal_only=TRUE(내부 전용 메모/코멘트, 광고주 미노출),
--     request 는 status(open→confirming→done) 상태전이.
CREATE TABLE IF NOT EXISTS trackb_tab_threads (
  id            BIGSERIAL PRIMARY KEY,
  sheet_id      TEXT NOT NULL,
  tab_name      TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','request')),
  body          TEXT NOT NULL,
  internal_only BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE = 내부(master/admin/staff)만, 광고주 미노출
  status        TEXT CHECK (status IN ('open','confirming','done')),  -- request 전용(comment 은 NULL)
  author_role   TEXT NOT NULL,                     -- master/admin/staff/advertiser
  author_name   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trackb_thread_tab
  ON trackb_tab_threads (sheet_id, tab_name) WHERE deleted_at IS NULL;

-- 미확인 배지용 seen 마킹(사용자별 마지막 열람 시각). user_key = 'role:name'(내부) 또는 'adv:<id>'(광고주).
CREATE TABLE IF NOT EXISTS trackb_thread_seen (
  user_key     TEXT NOT NULL,
  sheet_id     TEXT NOT NULL,
  tab_name     TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_key, sheet_id, tab_name)
);
