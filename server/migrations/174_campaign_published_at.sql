-- 174: 공고 게시 시각 + 같은 날 결정 하나 (어제 모집 부족 인원 팝업 — 결정 201)
-- ★ 173 와 분리한 이유: 173 가 이미 적용된 환경(PR 테섭)에 같은 파일 뒤에 덧붙이면 다시 실행되지 않아
--   부팅 프리플라이트가 컬럼 누락으로 거부했다(2026-10-02 실측). 적용된 마이그레이션 파일은 고치지 않는다.
-- ★ 게시(모집중)로 바뀐 시각 — "어제 열려 있었는가"를 신청 기록으로 추측하지 않기 위해(어제 0명 참여 = 가장 큰 부족).
--   지금 게시 중인 공고는 생성 시각으로 한 번만 채운다(배포 이전 게시 이력은 알 수 없으므로 — 이미 열려 있던 것으로 본다).
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
UPDATE recruit_campaigns SET published_at = created_at WHERE status = 'active' AND published_at IS NULL;

-- ★ 같은 공고·같은 날짜의 결정은 하나뿐 — 담당자와 AE가 동시에 [반영]해도 두 번 더해지지 않게 DB가 막는다.
--   (결정 기록과 변경을 한 트랜잭션에 넣는다 — campaignShortage.service.applyDecisions)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpe_shortage_decision
  ON campaign_plan_events (campaign_id, (detail->>'date'))
  WHERE action = 'shortage_decision';
