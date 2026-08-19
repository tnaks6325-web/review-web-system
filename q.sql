WITH raw_tabs AS (
  SELECT rst.sheet_id, rst.tab_name FROM raw_sheet_tabs rst
   WHERE rst.is_system_tab=FALSE
     AND EXISTS (SELECT 1 FROM index_master im WHERE im.status='active' AND im.sheet_id=rst.sheet_id
                    AND (im.tab_gid=rst.tab_gid OR im.tab_name=rst.tab_name))
), sl AS (SELECT tc.sheet_id, tc.tab_name FROM tab_configs tc
   WHERE COALESCE(tc.sheetless,FALSE)=TRUE AND COALESCE(tc.is_closed,FALSE)=FALSE),
at AS (SELECT * FROM raw_tabs UNION ALL SELECT s.* FROM sl s
   WHERE NOT EXISTS (SELECT 1 FROM raw_tabs r WHERE r.sheet_id=s.sheet_id AND r.tab_name=s.tab_name)),
live AS (SELECT t.* FROM at t JOIN tab_configs tc ON tc.sheet_id=t.sheet_id AND tc.tab_name=t.tab_name
   WHERE COALESCE(tc.sheetless,FALSE)=TRUE
     AND NOT EXISTS (SELECT 1 FROM trackb_tab_finished f WHERE f.deleted_at IS NULL AND f.sheet_id=t.sheet_id
          AND (f.tab_name=t.tab_name OR (COALESCE(tc.tab_gid,'')<>'' AND f.tab_name=tc.tab_gid)))),
m AS (
  SELECT cp.sheet_id, cp.tab_name, cp.seq, cp.phone8,
         ri.is_submitted, ri.is_submitted2,
         (SELECT count(*) FROM reviewers r WHERE r.phone8=cp.phone8) AS reg,
         (SELECT count(*) FROM payment_batch_items p
            WHERE p.tab_name=cp.tab_name AND p.row_index=cp.seq) AS pay_items,
         (SELECT count(*) FROM review_index ri2
            WHERE ri2.sheet_id=cp.sheet_id AND ri2.tab_name=cp.tab_name AND ri2.row_index=cp.seq) AS in_index
    FROM campaign_participants cp
    JOIN live l ON l.sheet_id=cp.sheet_id AND l.tab_name=cp.tab_name
    JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
    LEFT JOIN review_index ri ON ri.sheet_id=cp.sheet_id AND ri.tab_name=cp.tab_name AND ri.row_index=cp.seq
   WHERE cp.deleted_at IS NULL AND cp.active=TRUE
     AND COALESCE(cp.phone8,'')<>'' AND right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8)<>''
     AND cp.phone8 <> right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8))
SELECT cp2.tab_name, cp2.seq, cp2.row_json->>'번호' AS no,
       cp2.row_json->>'수취인' AS tbl_nm, cp2.phone8 AS tbl_p8,
       os2.recipient AS ord_nm, right(regexp_replace(COALESCE(os2.phone,''),'\D','','g'),8) AS ord_p8,
       (SELECT count(*) FROM reviewers r WHERE r.phone8=cp2.phone8) AS 표연락처_등록,
       (SELECT string_agg(r.name||'/'||COALESCE(r.bank_name,'')||' '||COALESCE(r.bank_account,''),' | ')
          FROM reviewers r WHERE r.phone8=cp2.phone8) AS 표연락처_계좌,
       (SELECT count(*) FROM reviewers r WHERE r.phone8=right(regexp_replace(COALESCE(os2.phone,''),'\D','','g'),8)) AS 주문연락처_등록,
       ri2.is_submitted, ri2.is_submitted2
  FROM campaign_participants cp2
  JOIN live l2 ON l2.sheet_id=cp2.sheet_id AND l2.tab_name=cp2.tab_name
  JOIN order_submissions os2 ON os2.id=cp2.order_submission_id AND os2.deleted_at IS NULL
  LEFT JOIN review_index ri2 ON ri2.sheet_id=cp2.sheet_id AND ri2.tab_name=cp2.tab_name AND ri2.row_index=cp2.seq
 WHERE cp2.deleted_at IS NULL AND cp2.active=TRUE
   AND COALESCE(cp2.phone8,'')<>'' AND right(regexp_replace(COALESCE(os2.phone,''),'\D','','g'),8)<>''
   AND cp2.phone8 <> right(regexp_replace(COALESCE(os2.phone,''),'\D','','g'),8)
   AND ri2.is_submitted IS TRUE AND ri2.is_submitted2 IS DISTINCT FROM 'PAID'
 ORDER BY cp2.tab_name, cp2.seq;
