\echo '=== 대상 줄 현재 상태 ==='
SELECT cp.id, cp.seq, cp.row_json->>'번호' AS no, cp.row_json->>'수취인' AS nm,
       cp.row_json->>'연락처' AS tbl_phone, cp.phone8, cp.identity_key,
       cp.recipient_name, os.phone AS ord_phone, os.recipient AS ord_nm, os.order_num
  FROM campaign_participants cp
  LEFT JOIN order_submissions os ON os.id = cp.order_submission_id
 WHERE cp.tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건'
   AND cp.seq = 204 AND cp.deleted_at IS NULL;
\echo '=== 같은 탭의 76422799 / 79422799 사용 줄 ==='
SELECT seq, row_json->>'번호' AS no, row_json->>'수취인' AS nm, phone8
  FROM campaign_participants
 WHERE tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건'
   AND deleted_at IS NULL AND phone8 IN ('76422799','79422799');
\echo '=== 편집 오버레이(identity/manual/order 앵커) ==='
SELECT pe.anchor_type, pe.anchor_value, pe.field_key
  FROM participant_edits pe
 WHERE pe.reverted_at IS NULL
   AND pe.anchor_value IN (
     SELECT identity_key FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND seq=204
     UNION SELECT id::text FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND seq=204
     UNION SELECT order_submission_id::text FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND seq=204);
\echo '=== 입금 회차 ==='
SELECT id, status, row_index, amount FROM payment_batch_items
 WHERE tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND row_index = 204;
\echo '=== 76422799 로 로그인 가능한 등록 리뷰어 ==='
SELECT id, name, phone FROM reviewers WHERE phone8 = '76422799';
\echo '=== 76422799 신원 링크 ==='
SELECT sheet_id, tab_name, row_index FROM participation_links WHERE phone8 = '76422799' LIMIT 10;
