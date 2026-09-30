-- 142: 리뷰어 소유자/실참여자 코드 기반(Phase 1).
--
-- 기존 이름·전화번호·phone8 기반 흐름을 바꾸지 않는 가산적 기반이다. migration runner는 매 기동 시
-- 모든 파일을 재실행하므로, 이 파일은 반드시 멱등이어야 한다. 아래 FK는 리뷰어 레코드의 무심한
-- 완전삭제를 막아, 코드가 부여된 신원과 과거 이력을 고아로 만들지 않는다.

CREATE SEQUENCE IF NOT EXISTS reviewer_code_seq AS BIGINT START WITH 1;

ALTER TABLE reviewers
  ADD COLUMN IF NOT EXISTS reviewer_no BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reviewers_reviewer_no
  ON reviewers (reviewer_no) WHERE reviewer_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS reviewer_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE RESTRICT,
  member_no         INTEGER NOT NULL CHECK (member_no >= 0),
  current_name      TEXT NOT NULL DEFAULT '',
  current_phone     TEXT NOT NULL DEFAULT '',
  current_phone8    TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'separated')),
  source            TEXT NOT NULL DEFAULT 'bootstrap',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  UNIQUE (owner_reviewer_id, member_no)
);

-- 이름/번호 변경은 기존 신원을 UPDATE로 덮어쓰지 않고 별칭을 더한다. 실제 변경 UI/쓰기 경로는
-- 다음 단계 feature flag 뒤에서만 이 테이블을 사용한다.
CREATE TABLE IF NOT EXISTS reviewer_identity_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id UUID NOT NULL REFERENCES reviewer_identities(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  phone8      TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT 'initial',
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reviewer_identity_aliases_open_phone8
  ON reviewer_identity_aliases (phone8) WHERE valid_to IS NULL AND phone8 <> '';

ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS owner_reviewer_id UUID REFERENCES reviewers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS participant_identity_id UUID REFERENCES reviewer_identities(id) ON DELETE RESTRICT;

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS owner_reviewer_id UUID REFERENCES reviewers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS participant_identity_id UUID REFERENCES reviewer_identities(id) ON DELETE RESTRICT;

ALTER TABLE participation_links
  ADD COLUMN IF NOT EXISTS owner_reviewer_id UUID REFERENCES reviewers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS participant_identity_id UUID REFERENCES reviewer_identities(id) ON DELETE RESTRICT;

ALTER TABLE campaign_participants
  ADD COLUMN IF NOT EXISTS owner_reviewer_id UUID REFERENCES reviewers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS participant_identity_id UUID REFERENCES reviewer_identities(id) ON DELETE RESTRICT;

ALTER TABLE payment_batch_items
  ADD COLUMN IF NOT EXISTS owner_reviewer_id UUID REFERENCES reviewers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS participant_identity_id UUID REFERENCES reviewer_identities(id) ON DELETE RESTRICT;

