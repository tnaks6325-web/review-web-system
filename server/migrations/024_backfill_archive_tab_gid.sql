-- 024: index_master_archive.tab_gid 백필
-- 목적: 마감/아카이브된 탭이 [+작업시트추가] 시 탭 이름 변경과 맞물려
--       대시보드에 다시 활성으로 재등장하는 버그의 근본 차단.
--
-- 배경: 대시보드 숨김(WHERE NOT EXISTS)과 add-tab 재등록 차단은 이름 OR gid로
--       아카이브 탭을 판별한다. 그러나 과거 아카이브 항목 중 tab_gid 가 NULL 인
--       경우, 구글시트에서 탭 이름이 바뀌면 이름도 gid도 매칭되지 않아 가드를 통과 →
--       tab_configs 에 신규 활성 탭으로 재삽입되어 대시보드에 되살아난다.
--
-- 처리: review_index_archive 에는 행별 tab_gid 가 보존돼 있으므로(시트 API 불필요),
--       이를 이용해 index_master_archive 의 NULL/빈 gid 를 채운다. (idempotent)
--       ※ migrate.js 는 매 부팅마다 전체 .sql 재실행 → NULL 만 갱신하므로 안전.

UPDATE index_master_archive ima
SET    tab_gid = sub.tab_gid
FROM (
  SELECT sheet_id, tab_name, MAX(tab_gid) AS tab_gid
  FROM   review_index_archive
  WHERE  tab_gid IS NOT NULL AND tab_gid <> ''
  GROUP  BY sheet_id, tab_name
) sub
WHERE  ima.sheet_id = sub.sheet_id
  AND  ima.tab_name = sub.tab_name
  AND  (ima.tab_gid IS NULL OR ima.tab_gid = '');
