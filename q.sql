\set ON_ERROR_STOP on
BEGIN;

\echo '=== 편집 오버레이 (identity/manual/order 앵커) ==='
SELECT pe.anchor_type, pe.anchor_value, pe.field, pe.value_text, pe.value_bool
  FROM participant_edits pe
 WHERE pe.reverted_at IS NULL
   AND pe.anchor_value IN ('num:278979435','c0b1ae3d-1ab7-46b6-9512-bd8274470cb4',
        (SELECT order_submission_id::text FROM campaign_participants WHERE id='c0b1ae3d-1ab7-46b6-9512-bd8274470cb4'));

\echo '=== 변경 전 ==='
SELECT seq, row_json->>'번호' AS no, row_json->>'수취인' AS nm, row_json->>'연락처' AS ph, phone8, identity_key
  FROM campaign_participants WHERE id = 'c0b1ae3d-1ab7-46b6-9512-bd8274470cb4';

\echo '=== 표 연락처 교정 (010-7642-2799 -> 010-7942-2799) ==='
WITH upd AS (
  UPDATE campaign_participants
     SET row_json = jsonb_set(row_json, '{연락처}', to_jsonb('010-7942-2799'::text)),
         phone8   = '79422799',
         updated_at = NOW()
   WHERE id = 'c0b1ae3d-1ab7-46b6-9512-bd8274470cb4'
     AND deleted_at IS NULL
     AND tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건'
     AND seq = 204
     AND row_json->>'연락처' = '010-7642-2799'
     AND phone8 = '76422799'
  RETURNING 1)
SELECT count(*) AS updated FROM upd \gset
\echo '변경 행 수:' :updated
SELECT CASE WHEN :updated = 1 THEN 'OK' ELSE (1/0)::text END AS guard;

\echo '=== 변경 후 ==='
SELECT seq, row_json->>'번호' AS no, row_json->>'수취인' AS nm, row_json->>'연락처' AS ph, phone8, identity_key
  FROM campaign_participants WHERE id = 'c0b1ae3d-1ab7-46b6-9512-bd8274470cb4';

\echo '=== 같은 탭 79422799 중복 확인(1줄이어야 함) ==='
SELECT count(*) FROM campaign_participants
 WHERE tab_name = '6/25(공영쇼핑)시크릿에이지_선크림+아이크림 200건'
   AND deleted_at IS NULL AND phone8 = '79422799';

COMMIT;
