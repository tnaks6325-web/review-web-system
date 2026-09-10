-- 156: 업로드 묶음 도입 전에 제출 완료된 행의 리뷰 파일을 완료 이력으로 백필한다.
-- 당시 여러 장을 함께 제출해도 upload_batch_id가 없으므로 대표 한 장만 남기면
-- 나머지 실제 제출 캡처가 다른 구매양식에서 재사용될 수 있다.

UPDATE review_submissions s
   SET completed_at = COALESCE(s.completed_at, NOW())
 WHERE s.completed_at IS NULL
   AND s.upload_batch_id IS NULL
   AND COALESCE(s.slot_key, 'review') = 'review'
   AND (
     EXISTS (
       SELECT 1
         FROM review_index ri
        WHERE ri.sheet_id = s.sheet_id
          AND ri.tab_name = s.tab_name
          AND ri.row_index = s.row_index
          AND ri.is_submitted = TRUE
     )
     OR EXISTS (
       SELECT 1
         FROM campaign_participants cp
        WHERE cp.sheet_id = s.sheet_id
          AND cp.tab_name = s.tab_name
          AND cp.seq = s.row_index
          AND cp.deleted_at IS NULL
          AND cp.is_submitted = TRUE
     )
   );
