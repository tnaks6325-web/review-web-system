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
  SELECT cp.sheet_id, cp.tab_name, cp.seq, COALESCE(cp.row_json->>'번호','') AS no,
         cp.phone8 AS row_p8, os.id AS oid, COALESCE(os.recipient,'') AS ord_name,
         right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8) AS ord_p8
    FROM campaign_participants cp
    JOIN live l ON l.sheet_id=cp.sheet_id AND l.tab_name=cp.tab_name
    JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
   WHERE cp.deleted_at IS NULL AND cp.active=TRUE
     AND COALESCE(cp.phone8,'')<>'' AND right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8)<>''
     AND cp.phone8 <> right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8)
)
SELECT n.tab_name, n.seq, n.no, n.row_p8, n.ord_name, n.ord_p8,
  /* 표연락처가 = 원장연락처 소유자의 타계정 */
  (SELECT count(*) FROM reviewers r, jsonb_array_elements(COALESCE(r.sub_accounts,'[]'::jsonb)) s
     WHERE r.phone8 = n.ord_p8
       AND right(regexp_replace(COALESCE(s->>'phone',''),'\D','','g'),8) = n.row_p8) AS row_is_sub_of_ord,
  /* 원장연락처가 = 표연락처 소유자의 타계정 */
  (SELECT count(*) FROM reviewers r, jsonb_array_elements(COALESCE(r.sub_accounts,'[]'::jsonb)) s
     WHERE r.phone8 = n.row_p8
       AND right(regexp_replace(COALESCE(s->>'phone',''),'\D','','g'),8) = n.ord_p8) AS ord_is_sub_of_row,
  /* 같은 소유자의 서로 다른 타계정 */
  (SELECT count(*) FROM reviewers r
     WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.sub_accounts,'[]'::jsonb)) a
                    WHERE right(regexp_replace(COALESCE(a->>'phone',''),'\D','','g'),8)=n.row_p8)
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.sub_accounts,'[]'::jsonb)) b
                    WHERE right(regexp_replace(COALESCE(b->>'phone',''),'\D','','g'),8)=n.ord_p8)) AS both_sub_same_owner,
  /* 그 주문의 홀드 명의/소유자 */
  COALESCE((SELECT ca.phone8 FROM campaign_applications ca WHERE ca.order_submission_id=n.oid LIMIT 1),'') AS hold_p8,
  COALESCE((SELECT ca.owner_phone8 FROM campaign_applications ca WHERE ca.order_submission_id=n.oid LIMIT 1),'') AS hold_owner,
  /* 표연락처·원장연락처가 등록 리뷰어인가 */
  (SELECT count(*) FROM reviewers r WHERE r.phone8=n.row_p8) AS row_reg,
  (SELECT count(*) FROM reviewers r WHERE r.phone8=n.ord_p8) AS ord_reg
FROM n ORDER BY n.tab_name, n.seq;
