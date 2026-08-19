\echo '=== 장수돌침대 75/76 링크 상태 (실행 후) ==='
SELECT seq, row_json->>'번호' AS no, row_json->>'수취인' AS nm,
       row_json->>'주문번호' AS tbl_num, order_submission_id,
       row_json->>'리뷰제출' AS rv, row_json->>'입금' AS pay
  FROM campaign_participants
 WHERE tab_name='0721)장수돌침대_쿠팡_탄소매트 900건' AND seq IN (74,75,76) AND deleted_at IS NULL
 ORDER BY seq;
\echo '=== 이지유 주문을 가리키는 살아있는 줄 (1줄이어야 함) ==='
SELECT count(*) FROM campaign_participants
 WHERE deleted_at IS NULL AND order_submission_id='3c3729cb-77b3-49aa-b854-daf1d4007257';
\echo '=== 그 주문이 취소되지 않았는지 ==='
SELECT id, mirror_status, deleted_at, canceled_by FROM order_submissions
 WHERE id='3c3729cb-77b3-49aa-b854-daf1d4007257';
