-- 166: 명의 카드(2단계 조각 1 · 가산 전용 · 결정 기록 175).
--
-- 리뷰어 밑의 명의(본인·타계정)를 "칸 순번"이 아니라 고유 번호(UUID)로 구분하는 카드 표.
-- ★ 이 조각에서는 아무 코드도 이 표를 읽지 않는다 — reviewers.sub_accounts 가 여전히 진실원본이다.
-- ★ 142 의 reviewer_identities 는 쓰지 않는다: 그 표는 이미 9개 파일이 읽어 채우는 순간 라이브 동작이
--   바뀌고, member_no = 배열 순번 + 1 로 주소·계좌를 찾으며, 열린 별칭 phone8 을 전역 유일로 강제해
--   "가족이 같은 번호를 쓰는 명의"(사용자 확정 2026-09-24 결정 1가 · 168명)를 담을 수 없다.
-- ★ 주민번호는 담지 않는다(민감정보 복제 확산 방지 — 조각 3 에서 다시 정한다).
-- 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다.

CREATE TABLE IF NOT EXISTS reviewer_identity_cards (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,  -- ★ 조각 1 = 사본이라 CASCADE(RESTRICT 면 등록리뷰어DB 삭제가 전부 막힌다). 카드가 진실원본이 되는 조각 3 에서 다시 정한다.
  kind              TEXT NOT NULL CHECK (kind IN ('self', 'sub')),
  name              TEXT NOT NULL,
  name_key          TEXT NOT NULL,             -- 공백 제거 이름(중복 판정 전용)
  phone             TEXT NOT NULL DEFAULT '',
  phone8            TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL DEFAULT '',
  bank_name         TEXT NOT NULL DEFAULT '',
  bank_account      TEXT NOT NULL DEFAULT '',
  account_holder    TEXT NOT NULL DEFAULT '',
  shopping_id       TEXT NOT NULL DEFAULT '',
  income_name       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'removed')),
  merged_into       UUID REFERENCES reviewer_identity_cards(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'backfill',
  source_index      INTEGER,                   -- 만들 당시 sub_accounts 칸 순번(추적용 · 판정에 쓰지 않는다)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  record_version    BIGINT NOT NULL DEFAULT 1
);

-- 본인 카드는 소유자당 하나.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_cards_active_self
  ON reviewer_identity_cards (owner_reviewer_id) WHERE kind = 'self' AND status = 'active';

-- 이름·번호가 완전히 같은 카드는 한 장만(결정: 완전 중복은 합친다). 같은 번호·다른 이름(가족)은 허용.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_cards_active_sig
  ON reviewer_identity_cards (owner_reviewer_id, name_key, phone8) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_identity_cards_phone8
  ON reviewer_identity_cards (phone8) WHERE status = 'active' AND phone8 <> '';
