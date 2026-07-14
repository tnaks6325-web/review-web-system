-- 050: Track B P2 (토글 write-back) — 오버레이 편집의 시트 반영 상태/서명(관측·멱등·자가치유).
--   ★ 가산적·비파괴·Track B 전용: participant_edits(048)에 컬럼 3개만 추가. 되돌리기 = 컬럼 DROP.
--   ★ 완전 inert: TRACK_B_WRITEBACK 미설정이면 write-back 엔진이 아예 안 돌아 이 컬럼은 관측값만.
--   writeback_status: NULL=미시도 · 'written'=시트 반영(멱등 완료) · 'held'=사람셀 충돌(클로버 금지, 비재시도)
--     · 'blocked'=신원 불일치/모호/컬럼 없음(자가치유 재시도 대상). 부팅 전량 재실행 idempotent.
ALTER TABLE participant_edits
  ADD COLUMN IF NOT EXISTS writeback_status TEXT,
  ADD COLUMN IF NOT EXISTS writeback_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS writeback_sig    TEXT;

-- 미반영/재시도 토글 편집만 빠르게 픽업(스윕 인덱스). 상태칸(is_submitted/is_paid) + 활성만.
CREATE INDEX IF NOT EXISTS idx_participant_edits_wb_pending
  ON participant_edits (sheet_id, tab_name)
  WHERE reverted_at IS NULL AND field IN ('is_submitted','is_paid')
    AND (writeback_status IS NULL OR writeback_status = 'blocked');
