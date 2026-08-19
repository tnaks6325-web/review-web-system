\echo '=== 대상 2줄 현재 상태 ==='
SELECT cp.sheet_id, cp.tab_name, cp.seq, cp.row_json->>'번호' AS no,
       cp.row_json->>'수취인' AS nm, cp.row_json->>'연락처' AS ph,
       cp.row_json->>'주문번호' AS tbl_ordnum,
       cp.order_submission_id AS cur_link, cp.identity_key,
       os.order_num AS cur_ordnum, os.recipient AS cur_rcp, os.sheet_row AS cur_sheet_row
  FROM campaign_participants cp
  LEFT JOIN order_submissions os ON os.id = cp.order_submission_id
 WHERE cp.deleted_at IS NULL AND (
       (cp.tab_name = '0721)장수돌침대_쿠팡_탄소매트 900건' AND cp.seq = 75)
    OR (cp.tab_name = '6/26(쿠팡)블랑루스_젤리미스트 270건'   AND cp.seq = 145));

\echo '=== 표 주문번호가 원장에 있는가 (그 탭 안) ==='
SELECT os.tab_name, os.id, os.order_num, os.recipient, os.phone, os.sheet_row,
       os.mirror_status, os.deleted_at, os.canceled_by,
       (SELECT count(*) FROM campaign_participants c2
         WHERE c2.deleted_at IS NULL AND c2.order_submission_id = os.id) AS linked_rows
  FROM order_submissions os
 WHERE os.tab_name IN ('0721)장수돌침대_쿠팡_탄소매트 900건','6/26(쿠팡)블랑루스_젤리미스트 270건')
   AND regexp_replace(COALESCE(os.order_num,''),'\D','','g')
       IN ('30101824728828','11101914181401');

\echo '=== 그 탭에서 seq 와 sheet_row 가 맞는 주문 (참고) ==='
SELECT os.tab_name, os.sheet_row, os.id, os.order_num, os.recipient, os.deleted_at
  FROM order_submissions os
 WHERE (os.tab_name = '0721)장수돌침대_쿠팡_탄소매트 900건' AND os.sheet_row = 75)
    OR (os.tab_name = '6/26(쿠팡)블랑루스_젤리미스트 270건'   AND os.sheet_row = 145);
