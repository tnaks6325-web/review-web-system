-- 042: Phase 2b — 참여자 로스터 → 시트 되쓰기용 열매핑·상태. 가산적·비파괴.
-- ★ 기본 무영향: 컬럼만 추가. 되쓰기는 PARTICIPANTS_SHEET_MIRROR=1 게이트 + master 트리거에서만.
--   submit_col/submit_col2 = review_index가 감지한 "리뷰제출/입금" 열 헤더명 복제(라이브 재감지 대신 저장값 사용).
--   last_sheet_write_sig 는 041에 이미 존재 — 추가 불필요.
ALTER TABLE campaign_participants
  ADD COLUMN IF NOT EXISTS submit_col    TEXT,
  ADD COLUMN IF NOT EXISTS submit_col2   TEXT,
  ADD COLUMN IF NOT EXISTS mirror_status TEXT;   -- pending|written|conflict|no_col|identity_mismatch|no_identity
