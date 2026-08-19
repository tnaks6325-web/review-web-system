\set QUIET on
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
), b AS (
  SELECT cp.*, os.recipient AS o_rcp, os.phone AS o_ph, os.order_num AS o_num
    FROM campaign_participants cp
    JOIN live l ON l.sheet_id=cp.sheet_id AND l.tab_name=cp.tab_name
    JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
   WHERE cp.deleted_at IS NULL AND cp.active=TRUE
), n AS (SELECT b.*,
   regexp_replace(COALESCE(recipient_name,''),'[\s ]','','g') AS rn,
   regexp_replace(COALESCE(o_rcp,''),'[\s ]','','g') AS on_,
   right(regexp_replace(COALESCE(o_ph,''),'\D','','g'),8) AS o_p8,
   regexp_replace(COALESCE(row_json->>'수취인',''),'[\s ]','','g') AS rj_rcp,
   regexp_replace(COALESCE(row_json->>'참여자',''),'[\s ]','','g') AS rj_join
  FROM b)
SELECT 'A 줄이름 <> 원장수취인' AS kind, count(*) FROM n WHERE rn<>'' AND on_<>'' AND rn<>on_
UNION ALL SELECT 'B 줄연락처 <> 원장연락처', count(*) FROM n WHERE COALESCE(phone8,'')<>'' AND o_p8<>'' AND phone8<>o_p8
UNION ALL SELECT 'C 표수취인 <> 줄이름', count(*) FROM n WHERE rj_rcp<>'' AND rn<>'' AND rj_rcp<>rn
UNION ALL SELECT 'D 표참여자 <> 표수취인', count(*) FROM n WHERE rj_join<>'' AND rj_rcp<>'' AND rj_join<>rj_rcp
UNION ALL SELECT 'E 표주문번호 <> 원장주문번호', count(*) FROM n
   WHERE length(regexp_replace(COALESCE(row_json->>'주문번호',''),'\D','','g'))>=6
     AND length(regexp_replace(COALESCE(o_num,''),'\D','','g'))>=6
     AND regexp_replace(COALESCE(row_json->>'주문번호',''),'\D','','g') <> regexp_replace(COALESCE(o_num,''),'\D','','g')
UNION ALL SELECT '총 링크된 줄', count(*) FROM n;
