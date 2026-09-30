-- 168: 리뷰어 홈 「리뷰 미작성 경고」·「받을 예정 금액」 조회용 인덱스 (decision 190)
--
-- 배경(운영 실측 2026-09-28): /api/reviewer/overdue-review-warning 약 50%, /review-earnings 약 9% 가
--   1.5초 조회 제한(statement_timeout)에 걸려 503 이었다. 원인은 "계정ID 또는 전화번호" 를 한 조건(OR)
--   으로 찾아 인덱스를 못 타고 표 전체를 읽은 것 — 특히 주문표는 전화번호 정리식(regexp)을 모든 행에
--   계산했다. 조회는 OR 을 갈래(UNION)로 나누고, 각 갈래가 탈 인덱스를 여기서 보탠다.
--
-- ★ 전부 가산(인덱스 추가만)이라 쓰기 경로 동작은 그대로다. 기존 관례대로 비-CONCURRENTLY
--   (migrate.js 가 파일을 한 번에 실행 — 051·144 와 같은 방식). 표가 수만~십만 행이라 생성은 1초 안팎.
-- ★ 조회 결과를 한 행도 바꾸지 않기 위해 인덱스에 삭제 여부 조건을 걸지 않았다(조회가 삭제된 주문도 본다).
-- 롤백: DROP INDEX IF EXISTS idx_os_phone8_all, idx_os_owner_reviewer, idx_cp_owner_reviewer,
--        idx_cp_phone8_all, idx_cp_participant_identity, idx_ca_owner_phone8, idx_pl_owner_reviewer;
CREATE INDEX IF NOT EXISTS idx_os_phone8_all
  ON order_submissions ((RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 8)));
CREATE INDEX IF NOT EXISTS idx_os_owner_reviewer
  ON order_submissions (owner_reviewer_id) WHERE owner_reviewer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cp_owner_reviewer
  ON campaign_participants (owner_reviewer_id) WHERE owner_reviewer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cp_phone8_all
  ON campaign_participants (phone8) WHERE phone8 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cp_participant_identity
  ON campaign_participants (participant_identity_id) WHERE participant_identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ca_owner_phone8
  ON campaign_applications (owner_phone8) WHERE owner_phone8 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pl_owner_reviewer
  ON participation_links (owner_reviewer_id) WHERE owner_reviewer_id IS NOT NULL;
