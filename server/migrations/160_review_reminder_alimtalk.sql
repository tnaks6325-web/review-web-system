-- 160: 리뷰 미작성 카카오 알림톡 3회 안내 및 미작성 종결 원장.
-- review_index.is_submitted(실제 제출)와 is_submitted2(입금)는 그대로 두고,
-- 알림/종결 상태와 공급자 발송 이력을 분리한다.

CREATE TABLE IF NOT EXISTS review_reminder_states (
  order_submission_id UUID PRIMARY KEY REFERENCES order_submissions(id) ON DELETE RESTRICT,
  review_index_id      UUID NOT NULL,
  sheet_id             TEXT NOT NULL,
  tab_name             TEXT NOT NULL,
  row_index            INTEGER NOT NULL,
  reviewer_name        TEXT NOT NULL DEFAULT '',
  phone8               TEXT NOT NULL DEFAULT '',
  product_name         TEXT NOT NULL DEFAULT '',
  review_deadline_at   TIMESTAMPTZ NOT NULL,
  review_status        TEXT NOT NULL DEFAULT 'pending'
                       CHECK (review_status IN ('pending','submitted','closed_no_review','cancelled')),
  reminder_count       SMALLINT NOT NULL DEFAULT 0 CHECK (reminder_count BETWEEN 0 AND 3),
  last_reminded_at     TIMESTAMPTZ,
  final_due_at         TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,
  close_reason         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_reminder_states_due
  ON review_reminder_states(review_status, reminder_count, last_reminded_at, final_due_at);
CREATE INDEX IF NOT EXISTS idx_review_reminder_states_review_index
  ON review_reminder_states(review_index_id, review_status);
CREATE INDEX IF NOT EXISTS idx_review_reminder_states_row
  ON review_reminder_states(sheet_id, tab_name, row_index);

CREATE TABLE IF NOT EXISTS review_reminder_deliveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_submission_id UUID NOT NULL REFERENCES review_reminder_states(order_submission_id) ON DELETE CASCADE,
  reminder_no         SMALLINT NOT NULL CHECK (reminder_no BETWEEN 1 AND 3),
  attempt_no          INTEGER NOT NULL CHECK (attempt_no > 0),
  template_name       TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  target_phone        TEXT NOT NULL,
  template_variables  JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_status     TEXT NOT NULL
                      CHECK (provider_status IN ('accepted','delivered','failed')),
  provider_message_id TEXT,
  provider_group_id   TEXT,
  provider_status_code TEXT,
  provider_reason     TEXT,
  final_due_at        TIMESTAMPTZ,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_submission_id, reminder_no, attempt_no)
);

-- 같은 작업·회차에 처리 결과가 나오지 않은 접수는 하나만 허용한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_reminder_delivery_open
  ON review_reminder_deliveries(order_submission_id, reminder_no)
  WHERE provider_status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_review_reminder_deliveries_provider
  ON review_reminder_deliveries(provider_status, requested_at)
  WHERE provider_status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_review_reminder_deliveries_daily
  ON review_reminder_deliveries(requested_at, provider_status);
