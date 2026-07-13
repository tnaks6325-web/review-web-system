-- 052: write-back status 어휘 고정(R3 방어) — {NULL,'written','held','blocked'} 외 기록을 DB 레벨로 금지.
--   근거: 구버전 픽업 술어(writeback_status IS NULL OR ='blocked')와의 롤백 호환을 코드 화이트리스트
--   (markStatus)만이 아니라 CHECK 로도 강제(코드 드리프트 백스톱). NOT VALID = 기존 행 스캔/락 없음.
--   되돌리기 = DROP CONSTRAINT (비파괴·가산적).
ALTER TABLE participant_edits
  DROP CONSTRAINT IF EXISTS chk_participant_edits_wb_status;
ALTER TABLE participant_edits
  ADD CONSTRAINT chk_participant_edits_wb_status
  CHECK (writeback_status IS NULL OR writeback_status IN ('written','held','blocked')) NOT VALID;
