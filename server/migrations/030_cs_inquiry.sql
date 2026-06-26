-- 030_cs_inquiry.sql
-- 리뷰어 C/S 문의창구 (중앙관리)
-- 리뷰어 ↔ 관리자 메신저형 문의. 방 단위 = 리뷰어 + 캠페인.
-- ※ migrate.js 가 매번 전체 .sql 을 재실행하므로 반드시 idempotent.

-- ── 1) 문의 스레드(대화방): 리뷰어 + 캠페인당 1개 ──
CREATE TABLE IF NOT EXISTS cs_threads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_phone8       TEXT NOT NULL,                 -- 리뷰어 식별(시스템 기본키)
  reviewer_name         TEXT DEFAULT '',
  campaign_key          TEXT NOT NULL DEFAULT '',      -- recruit_campaigns.id | 'sheetId||tabName' | '' (일반문의). FK 아님(식별자 공간 혼재)
  campaign_label        TEXT NOT NULL DEFAULT '문의',  -- 리뷰어/관리자에게 보이는 캠페인명
  campaign_source       TEXT NOT NULL DEFAULT 'general'
                        CHECK (campaign_source IN ('recruit','review_index','general')),
  status                TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','closed')),
  last_message_at       TIMESTAMPTZ,
  last_message_preview  TEXT DEFAULT '',
  admin_unread_count    INTEGER NOT NULL DEFAULT 0,    -- 리뷰어가 보낸 미확인 (관리자 탭 뱃지)
  reviewer_unread_count INTEGER NOT NULL DEFAULT 0,    -- 관리자가 보낸 미확인
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (reviewer_phone8, campaign_key)
);
CREATE INDEX IF NOT EXISTS idx_cs_threads_phone8    ON cs_threads(reviewer_phone8);
CREATE INDEX IF NOT EXISTS idx_cs_threads_status    ON cs_threads(status);
CREATE INDEX IF NOT EXISTS idx_cs_threads_last_msg  ON cs_threads(last_message_at DESC);

-- ── 2) 문의 메시지 ──
CREATE TABLE IF NOT EXISTS cs_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    UUID NOT NULL REFERENCES cs_threads(id) ON DELETE CASCADE,
  sender_role  TEXT NOT NULL CHECK (sender_role IN ('reviewer','admin')),
  sender_name  TEXT DEFAULT '',
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cs_messages_thread  ON cs_messages(thread_id, created_at);

-- ── 3) 관리자 전용 메모 (리뷰어정보로 영구 보존, 리뷰어에게는 비공개) ──
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS admin_memo TEXT DEFAULT '';
