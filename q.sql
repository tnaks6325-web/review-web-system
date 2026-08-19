\echo '=== 현재 링크된 주문을 가리키는 살아있는 줄 전부 ==='
SELECT cp.tab_name, cp.seq, cp.row_json->>'번호' AS no, cp.row_json->>'수취인' AS nm,
       cp.row_json->>'주문번호' AS tbl_num, cp.order_submission_id
  FROM campaign_participants cp
 WHERE cp.deleted_at IS NULL
   AND cp.order_submission_id IN ('3c3729cb-77b3-49aa-b854-daf1d4007257','2a845bfc-2df1-4ea2-8cdd-8867c76d67e4')
 ORDER BY cp.tab_name, cp.seq;

\echo '=== 그 두 주문의 원장 상태 ==='
SELECT id, tab_name, sheet_row, order_num, recipient, phone, price, mirror_status, deleted_at, canceled_by,
       to_char(submitted_at,'MM-DD HH24:MI') AS sub_at
  FROM order_submissions
 WHERE id IN ('3c3729cb-77b3-49aa-b854-daf1d4007257','2a845bfc-2df1-4ea2-8cdd-8867c76d67e4');

\echo '=== 표 주문번호가 원장 어디에든 있는가(탭 무관) ==='
SELECT id, tab_name, sheet_row, order_num, recipient, deleted_at
  FROM order_submissions
 WHERE regexp_replace(COALESCE(order_num,''),'\D','','g') IN ('30101824728828','11101914181401');

\echo '=== 두 줄의 리뷰/입금 상태 · 입금 회차 ==='
SELECT cp.tab_name, cp.seq,
       cp.row_json->>'리뷰제출' AS rv1, cp.row_json->>'리뷰제출일' AS rv2,
       cp.row_json->>'입금' AS pay, cp.row_json->>'결제금액' AS amt,
       (SELECT count(*) FROM payment_batch_items p
         WHERE p.tab_name=cp.tab_name AND p.row_index=cp.seq) AS pay_items
  FROM campaign_participants cp
 WHERE cp.deleted_at IS NULL AND (
       (cp.tab_name='0721)장수돌침대_쿠팡_탄소매트 900건' AND cp.seq=75)
    OR (cp.tab_name='6/26(쿠팡)블랑루스_젤리미스트 270건' AND cp.seq=145));

\echo '=== 표 연락처로 그 탭에 주문이 있는가(비운 뒤 재부착 위험) ==='
SELECT '장수돌침대 53849851' AS k, count(*) FROM order_submissions
 WHERE tab_name='0721)장수돌침대_쿠팡_탄소매트 900건' AND deleted_at IS NULL
   AND right(regexp_replace(COALESCE(phone,''),'\D','','g'),8)='53849851'
UNION ALL
SELECT '블랑루스 32250135', count(*) FROM order_submissions
 WHERE tab_name='6/26(쿠팡)블랑루스_젤리미스트 270건' AND deleted_at IS NULL
   AND right(regexp_replace(COALESCE(phone,''),'\D','','g'),8)='32250135';
