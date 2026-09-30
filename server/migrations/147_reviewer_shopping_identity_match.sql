-- 147: 명의별 공통 쇼핑몰 아이디 + 주문캡처 선택명의 판정 감사원장
--
-- reviewers.phone8은 비고유이므로 신규 쓰기는 애플리케이션에서 reviewers.id(UUID)로만 수행한다.
-- 타계정 레거시는 sub_accounts[].shoppingId를 유지하고, 코드 신원이 있는 경우에는
-- reviewer_identities.shopping_id를 안정 저장소로 함께 사용한다.

ALTER TABLE reviewers
  ADD COLUMN IF NOT EXISTS shopping_id TEXT NOT NULL DEFAULT '';

ALTER TABLE reviewer_identities
  ADD COLUMN IF NOT EXISTS shopping_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS reviewer_identity_match_audits (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_application_id BIGINT NOT NULL REFERENCES campaign_applications(id) ON DELETE CASCADE,
  owner_reviewer_id       UUID NOT NULL REFERENCES reviewers(id) ON DELETE RESTRICT,
  participant_identity_id UUID REFERENCES reviewer_identities(id) ON DELETE SET NULL,
  selected_identity_hash  TEXT NOT NULL,
  image_hash              TEXT NOT NULL DEFAULT '',
  extracted_fields_hash   TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL,
  approval_mode           TEXT NOT NULL DEFAULT 'automatic',
  reason_codes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviewer_identity_match_audits_app
  ON reviewer_identity_match_audits (campaign_application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reviewer_identity_match_audits_owner
  ON reviewer_identity_match_audits (owner_reviewer_id, created_at DESC);
