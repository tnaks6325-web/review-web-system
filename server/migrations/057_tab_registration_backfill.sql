-- 057: 탭 등록 단일경로(작업오더 접수) 전환 — 그랜드파더 백필 (1회성)
--   게이트 기준이 "tab_configs 존재"가 되므로, 드리프트로 index_master(active)에만 있고
--   tab_configs에 없는 탭이 빌드에서 끊기지 않도록 tab_configs 행을 1회 보충한다.
--   ★ 1회성 가드(app_settings 'migration_057_tab_backfill_done'): 마이그레이션은 매 배포마다
--     재실행되므로, 이후 운영 중 정당하게 삭제된 tab_configs 행이 재배포 때마다
--     부활하지 않게 최초 1회만 백필한다. 아카이브된 탭(이름/gid 매칭)은 백필 제외.
INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheet_url, updated_at)
SELECT
  im.sheet_id,
  im.tab_name,
  NULLIF(im.tab_gid, ''),
  im.campaign_name,
  'https://docs.google.com/spreadsheets/d/' || im.sheet_id || '/edit',
  NOW()
FROM index_master im
WHERE NOT EXISTS (SELECT 1 FROM app_settings s WHERE s.key = 'migration_057_tab_backfill_done')
  AND im.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM tab_configs tc
    WHERE tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
  )
  AND NOT EXISTS (
    SELECT 1 FROM index_master_archive ima
    WHERE ima.sheet_id = im.sheet_id
      AND (ima.tab_name = im.tab_name
           OR (ima.tab_gid IS NOT NULL AND ima.tab_gid <> '' AND ima.tab_gid = im.tab_gid))
  )
ON CONFLICT (sheet_id, tab_name) DO NOTHING;

INSERT INTO app_settings (key, value)
VALUES ('migration_057_tab_backfill_done', NOW()::text)
ON CONFLICT (key) DO NOTHING;
