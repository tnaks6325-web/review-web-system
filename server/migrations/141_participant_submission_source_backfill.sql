-- 141: 리뷰 제출 상태의 원본을 campaign_participants로 통일한다.
-- 작업표 리뷰제출 칸에 값이 있지만 과거 동기화 누락으로 플래그가 false인 활성 행만 보정한다.
UPDATE campaign_participants cp
   SET is_submitted = TRUE,
       updated_at = NOW(),
       updated_by = 'migration:141_participant_submission_source_backfill'
  FROM review_index ri
 WHERE ri.sheet_id = cp.sheet_id
   AND ri.tab_name = cp.tab_name
   AND ri.row_index = cp.seq
   AND cp.deleted_at IS NULL
   AND cp.active = TRUE
   AND cp.is_submitted = FALSE
   AND COALESCE(NULLIF(btrim(ri.submit_col), ''), '') <> ''
   AND COALESCE(NULLIF(btrim(cp.row_json ->> ri.submit_col), ''), '') <> '';
