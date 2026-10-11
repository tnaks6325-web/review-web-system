-- 183: 명의 규칙 관찰 기록(신원 기준 재정립 3-1 · 결정 222).
--   새 규칙은 처음에 아무것도 막지 않고 "켰다면 막았을 저장"만 여기에 남긴다(관찰 모드).
--   운영 데이터로 정상 리뷰어가 걸리지 않음을 확인한 뒤에만 차단을 켠다(라이브 무중단 원칙).
--   ★ 추가만 하는 기록 표 — 다른 표를 바꾸지 않는다. 이름·전화번호는 저장하지 않는다(소유자 번호·칸 순번·규칙만).
CREATE TABLE IF NOT EXISTS identity_rule_observations (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT '',            -- 어느 입구(profile · register · order_enrich · external_order ...)
  owner_reviewer_id UUID NULL,
  rule_code TEXT NOT NULL,                    -- same_as_self · duplicate_in_list · other_owner_self_phone · other_owner_sub_phone · limit · missing_name_or_phone
  sub_index INT NULL,                          -- 저장된 목록에서 몇 번째 칸인지
  other_owner_reviewer_id UUID NULL,          -- 번호가 겹친 다른 소유자(있으면)
  mode TEXT NOT NULL DEFAULT 'observe'
);
CREATE INDEX IF NOT EXISTS idx_identity_rule_observations_created ON identity_rule_observations (created_at DESC);
