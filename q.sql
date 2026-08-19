WITH raw_tabs AS (
  SELECT rst.sheet_id, rst.tab_name FROM raw_sheet_tabs rst
   WHERE rst.is_system_tab = FALSE
     AND EXISTS (SELECT 1 FROM index_master im WHERE im.status='active' AND im.sheet_id=rst.sheet_id
                    AND (im.tab_gid=rst.tab_gid OR im.tab_name=rst.tab_name))
), sheetless_tabs AS (
  SELECT tc.sheet_id, tc.tab_name FROM tab_configs tc
   WHERE COALESCE(tc.sheetless,FALSE)=TRUE AND COALESCE(tc.is_closed,FALSE)=FALSE
), all_tabs AS (
  SELECT * FROM raw_tabs UNION ALL
  SELECT s.* FROM sheetless_tabs s WHERE NOT EXISTS (SELECT 1 FROM raw_tabs r WHERE r.sheet_id=s.sheet_id AND r.tab_name=s.tab_name)
), live AS (
  SELECT t.* FROM all_tabs t JOIN tab_configs tc ON tc.sheet_id=t.sheet_id AND tc.tab_name=t.tab_name
   WHERE COALESCE(tc.sheetless,FALSE)=TRUE
     AND NOT EXISTS (SELECT 1 FROM trackb_tab_finished f WHERE f.deleted_at IS NULL AND f.sheet_id=t.sheet_id
          AND (f.tab_name=t.tab_name OR (COALESCE(tc.tab_gid,'')<>'' AND f.tab_name=tc.tab_gid)))
), n AS (
  SELECT cp.tab_name, cp.seq, COALESCE(cp.row_json->>'번호','') AS no,
         cp.phone8 AS cp_p8,
         right(regexp_replace(COALESCE(cp.row_json->>'연락처',''),'\D','','g'),8) AS rj_p8,
         COALESCE(cp.row_json->>'수취인','') AS rj_rcp,
         COALESCE(cp.row_json->>'주문자','') AS rj_orderer,
         COALESCE(os.recipient,'') AS ord_name,
         right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8) AS ord_p8,
         COALESCE(os.orderer,'') AS ord_orderer,
         os.submitted_at
    FROM campaign_participants cp
    JOIN live l ON l.sheet_id=cp.sheet_id AND l.tab_name=cp.tab_name
    JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
   WHERE cp.deleted_at IS NULL AND cp.active=TRUE
     AND COALESCE(cp.phone8,'')<>'' AND right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8)<>''
     AND cp.phone8 <> right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8)
)
SELECT tab_name, seq, no, cp_p8, rj_p8, ord_p8,
       CASE WHEN rj_p8=ord_p8 THEN 'cp만틀림' WHEN rj_p8=cp_p8 THEN '표=cp, 원장다름' ELSE '셋다다름' END AS verdict,
       rj_rcp, ord_name, rj_orderer, ord_orderer, to_char(submitted_at,'MM-DD HH24:MI') AS sub_at
  FROM n ORDER BY tab_name, seq;
