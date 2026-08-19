WITH a(tab,seq) AS (VALUES
 ('0612)네이버_멀티비타민_50건',21),
 ('네이버)0720_논알콜맥주3종_300건',136),
 ('네이버)0720_논알콜맥주3종_300건',138),
 ('네이버)0720_논알콜맥주3종_300건',139),
 ('네이버)0720_논알콜맥주3종_300건',144),
 ('0721)장수돌침대_쿠팡_탄소매트 900건',74),
 ('5/6(메이커스)메디슨벨_알약패치 200건',137),
 ('5/6(메이커스)메디슨벨_알약패치 200건',183),
 ('6/10_쟈니베어_쿠팡_온열안대_500건',291),
 ('6/26(쿠팡)블랑루스_젤리미스트 270건',144),
 ('6/26(쿠팡)블랑루스_젤리미스트 270건',147))
SELECT cp.tab_name, cp.seq, cp.row_json->>'번호' AS no,
  cp.row_json->>'수취인' AS tbl_nm, cp.phone8 AS tbl_p8,
  os.recipient AS ord_nm, right(regexp_replace(COALESCE(os.phone,''),'\D','','g'),8) AS ord_p8,
  /* 표에 적힌 사람이 그 탭에 자기 주문을 갖고 있는가 (연락처 기준) */
  (SELECT count(*) FROM order_submissions o2
    WHERE o2.tab_name=cp.tab_name AND o2.deleted_at IS NULL
      AND right(regexp_replace(COALESCE(o2.phone,''),'\D','','g'),8)=cp.phone8) AS tblperson_orders,
  /* 그 주문이 있다면 어느 줄이 그것을 가리키나 */
  COALESCE((SELECT string_agg(c2.seq::text,',') FROM campaign_participants c2
     JOIN order_submissions o3 ON o3.id=c2.order_submission_id
    WHERE c2.tab_name=cp.tab_name AND c2.deleted_at IS NULL
      AND right(regexp_replace(COALESCE(o3.phone,''),'\D','','g'),8)=cp.phone8),'(없음)') AS tblperson_linked_seq,
  /* 표에 적힌 사람이 그 탭의 다른 줄에도 이름으로 올라 있나 */
  COALESCE((SELECT string_agg(c3.seq::text,',') FROM campaign_participants c3
    WHERE c3.tab_name=cp.tab_name AND c3.deleted_at IS NULL AND c3.seq<>cp.seq
      AND c3.phone8=cp.phone8),'(없음)') AS same_p8_other_rows,
  /* 이 줄의 리뷰·입금·이미지·회차 */
  CASE WHEN btrim(COALESCE(cp.row_json->>'리뷰제출',''))<>'' OR btrim(COALESCE(cp.row_json->>'리뷰제출일',''))<>'' THEN 'O' ELSE '-' END AS rv,
  CASE WHEN btrim(COALESCE(cp.row_json->>'입금',''))<>'' THEN 'O' ELSE '-' END AS pay,
  (SELECT count(*) FROM review_submissions rs
    WHERE rs.sheet_id=cp.sheet_id AND rs.tab_name=cp.tab_name AND rs.row_index=cp.seq) AS imgs,
  (SELECT count(*) FROM payment_batch_items p
    WHERE p.tab_name=cp.tab_name AND p.row_index=cp.seq) AS pay_items
FROM campaign_participants cp
LEFT JOIN order_submissions os ON os.id = cp.order_submission_id
JOIN a ON a.tab=cp.tab_name AND a.seq=cp.seq
WHERE cp.deleted_at IS NULL

ORDER BY cp.tab_name, cp.seq;
