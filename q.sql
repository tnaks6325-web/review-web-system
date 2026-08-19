WITH t(tab,seq) AS (VALUES
 ('0629)친구사이_하절기 7차',26),
 ('0724)유산균파우더_쿠팡&네이버 60건',69),
 ('6/10_쟈니베어_쿠팡_온열안대_500건',54),
 ('6/10_쟈니베어_쿠팡_온열안대_500건',325),
 ('6/10_쟈니베어_쿠팡_온열안대_500건',397),
 ('6/10_쟈니베어_쿠팡_온열안대_500건',407),
 ('6/18아르퓨레행주_쿠팡500건',285),
 ('6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건',204),
 ('6/26(쿠팡)블랑루스_젤리미스트 270건',197))
SELECT cp.tab_name, cp.seq, COALESCE(cp.row_json->>'번호','') AS no,
       COALESCE(cp.row_json->>'수취인','') AS nm,
       COALESCE(cp.row_json->>'연락처','') AS tbl_phone,
       COALESCE(os.phone,'') AS ord_phone,
       length(regexp_replace(COALESCE(os.phone,''),'\D','','g')) AS ord_len,
       COALESCE((SELECT string_agg(DISTINCT r.phone, ' | ') FROM reviewers r
                  WHERE regexp_replace(COALESCE(r.name,''),'[\s ]','','g')
                        = regexp_replace(COALESCE(cp.row_json->>'수취인',''),'[\s ]','','g')),'(등록없음)') AS reg_phone_by_name,
       COALESCE((SELECT string_agg(DISTINCT r.name||'/'||r.phone, ' | ') FROM reviewers r
                  WHERE r.phone8 = right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8)),'(등록없음)') AS reg_by_ordp8
  FROM campaign_participants cp
  JOIN t ON t.tab = cp.tab_name AND t.seq = cp.seq
  JOIN order_submissions os ON os.id = cp.order_submission_id
 WHERE cp.deleted_at IS NULL
 ORDER BY cp.tab_name, cp.seq;
