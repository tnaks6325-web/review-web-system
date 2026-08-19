\echo '=== 대상 줄 현재 상태 ==='
SELECT cp.id, cp.sheet_id, cp.tab_name, cp.seq,
       cp.row_json->>'번호' AS no, cp.row_json->>'수취인' AS nm,
       cp.row_json->>'연락처' AS tbl_phone, cp.phone8, cp.identity_key,
       cp.recipient_name, cp.order_submission_id,
       os.phone AS ord_phone, os.recipient AS ord_nm, os.order_num
  FROM campaign_participants cp
  LEFT JOIN order_submissions os ON os.id = cp.order_submission_id
 WHERE cp.tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건'
   AND cp.seq = 204 AND cp.deleted_at IS NULL;

\echo '=== 같은 탭에 76422799 를 쓰는 다른 줄 ==='
SELECT seq, row_json->>'번호' AS no, row_json->>'수취인' AS nm, phone8
  FROM campaign_participants
 WHERE tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건'
   AND deleted_at IS NULL AND phone8 IN ('76422799','79422799');

\echo '=== 그 줄에 매달린 편집 오버레이 ==='
SELECT 'participant_edits' AS t, anchor_type, anchor_value, field_key
  FROM participant_edits pe
 WHERE pe.reverted_at IS NULL AND pe.sheet_id IN (SELECT sheet_id FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' LIMIT 1)
   AND pe.anchor_value IN (
     SELECT identity_key FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND seq=204
     UNION SELECT id::text FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND seq=204
     UNION SELECT order_submission_id::text FROM campaign_participants WHERE tab_name='6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND seq=204);

\echo '=== 입금 회차에 담겼는지 ==='
SELECT pbi.id, pbi.status, pbi.row_index, pbi.amount
  FROM payment_batch_items pbi
 WHERE pbi.tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건' AND pbi.row_index = 204;

\echo '=== 76422799 로 로그인 가능한 등록 리뷰어 ==='
SELECT id, name, phone FROM reviewers WHERE phone8 = '76422799';
