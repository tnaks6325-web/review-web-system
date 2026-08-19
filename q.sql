WITH raw_tabs AS (
  SELECT rst.sheet_id AS sheet_id, rst.tab_name AS tab_name
    FROM raw_sheet_tabs rst
    LEFT JOIN tab_configs tc ON tc.sheet_id = rst.sheet_id AND tc.tab_name = rst.tab_name
   WHERE rst.is_system_tab = FALSE
     AND EXISTS (SELECT 1 FROM index_master im
                  WHERE im.status='active' AND im.sheet_id=rst.sheet_id
                    AND (im.tab_gid=rst.tab_gid OR im.tab_name=rst.tab_name))
), sheetless_tabs AS (
  SELECT tc.sheet_id, tc.tab_name
    FROM tab_configs tc
   WHERE COALESCE(tc.sheetless,FALSE)=TRUE AND COALESCE(tc.is_closed,FALSE)=FALSE
), all_tabs AS (
  SELECT * FROM raw_tabs
  UNION ALL
  SELECT s.* FROM sheetless_tabs s
   WHERE NOT EXISTS (SELECT 1 FROM raw_tabs r WHERE r.sheet_id=s.sheet_id AND r.tab_name=s.tab_name)
), live AS (
  SELECT t.* FROM all_tabs t
   JOIN tab_configs tc ON tc.sheet_id=t.sheet_id AND tc.tab_name=t.tab_name
   WHERE COALESCE(tc.sheetless,FALSE)=TRUE
     AND NOT EXISTS (
       SELECT 1 FROM trackb_tab_finished f
        WHERE f.deleted_at IS NULL AND f.sheet_id=t.sheet_id
          AND (f.tab_name=t.tab_name OR (COALESCE(tc.tab_gid,'')<>'' AND f.tab_name=tc.tab_gid))
     )
)
SELECT cp.tab_name, cp.seq,
       COALESCE(cp.row_json->>'번호','') AS no,
       COALESCE(cp.recipient_name,'') AS row_name,
       COALESCE(os.recipient,'') AS order_name,
       COALESCE(cp.phone8,'') AS ph,
       COALESCE(cp.row_json->>'구매일자','') AS pdate,
       CASE WHEN cp.row_json->>'리뷰제출' IS NOT NULL AND btrim(cp.row_json->>'리뷰제출')<>'' THEN 'O' ELSE '-' END AS rv
  FROM campaign_participants cp
  JOIN live l ON l.sheet_id=cp.sheet_id AND l.tab_name=cp.tab_name
  JOIN order_submissions os ON os.id = cp.order_submission_id
 WHERE cp.deleted_at IS NULL AND cp.active = TRUE
   AND os.deleted_at IS NULL
   AND regexp_replace(COALESCE(cp.recipient_name,''),'[\s ]','','g') <> ''
   AND regexp_replace(COALESCE(os.recipient,''),'[\s ]','','g') <> ''
   AND regexp_replace(COALESCE(cp.recipient_name,''),'[\s ]','','g')
       <> regexp_replace(COALESCE(os.recipient,''),'[\s ]','','g')
 ORDER BY cp.tab_name, cp.seq;
