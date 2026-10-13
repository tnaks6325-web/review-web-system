-- 186: 본계정 추가 배송지(결정 226 · 사용자 확정 2026-10-13 (나)).
--
-- 같은 번호 타계정을 본계정으로 합칠 때(185 fold_self) 그 타계정의 받는 사람 이름·주소를 본계정의 "추가 배송지"로 남긴다.
--   - 구매양식 「내 정보에서 선택」·주소 고르기에 본계정 주소와 함께 나온다(본계정 자신의 주소 — 결정 181 ④의 "다른 명의 주소"가 아니다).
--   - 본계정 번호로 이 주소에 받은 주문은 등록 주소로 인정한다(명의 확인 · 제출 관문).
-- ★ 정리를 되돌리면 그 판단이 만든 줄은 지운다(decision_id). 같은 소유자 · 같은 주소 · 같은 받는 사람은 한 줄
--   (받는 사람이 다르면 따로 남긴다 — 같은 주소를 두 이름이 쓰면 둘 다 고를 수 있게 · 주소 고르기는 화면이 주소로 합친다).
-- ★ 가산 전용 · 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다.

CREATE TABLE IF NOT EXISTS reviewer_delivery_addresses (
  id                BIGSERIAL PRIMARY KEY,
  owner_reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  recipient         TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL,
  address_key       TEXT NOT NULL,                       -- 공백·기호 정리한 비교 키(중복 막기)
  source            TEXT NOT NULL DEFAULT 'fold' CHECK (source IN ('fold')),
  decision_id       BIGINT REFERENCES reviewer_identity_decisions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reviewer_delivery_addresses_owner_key_recipient
  ON reviewer_delivery_addresses (owner_reviewer_id, address_key, recipient);
CREATE INDEX IF NOT EXISTS idx_reviewer_delivery_addresses_decision
  ON reviewer_delivery_addresses (decision_id) WHERE decision_id IS NOT NULL;
