-- 171: 작업보드에서 담당자가 직접 보낸 문자·알림톡 기록(사용자 확정 2026-09-30, 시안 A).
--   ★ 알림톡은 자동 알림 원장(review_reminder_deliveries)에도 그 회차로 남는다 — 이 표는 "누가 언제 누구에게
--     무엇을 보냈나"를 사람이 보는 기록이다(자동 발송 판정은 이 표를 읽지 않는다).
--   ★ 신규 테이블만 · FK 없음(작업표 줄이 지워져도 발송 기록은 남아야 한다).
CREATE TABLE IF NOT EXISTS manual_message_sends (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                TEXT NOT NULL,              -- 'sms' | 'alimtalk'
  sheet_id            TEXT NOT NULL DEFAULT '',
  tab_name            TEXT NOT NULL DEFAULT '',
  participant_id      TEXT NOT NULL DEFAULT '',
  order_submission_id TEXT NOT NULL DEFAULT '',
  reviewer_name       TEXT NOT NULL DEFAULT '',
  target_phone        TEXT NOT NULL DEFAULT '',
  message_text        TEXT NOT NULL DEFAULT '',
  message_type        TEXT NOT NULL DEFAULT '',   -- SMS | LMS | ATA
  reminder_no         SMALLINT,
  accepted            BOOLEAN NOT NULL DEFAULT FALSE,
  provider_message_id TEXT,
  provider_reason     TEXT NOT NULL DEFAULT '',
  sent_by             TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manual_message_sends_tab ON manual_message_sends(sheet_id, tab_name, created_at DESC);
