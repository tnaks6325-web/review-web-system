-- 204: 예전 ⬛ 보관 작업의 Drive 폴더 주소를 보관 기록에 남긴다 (2026-10-27)
--
-- 왜: 옛 관리자 대시보드의 ⬛ 마감(/api/archive/*, 결정 270 에서 삭제)은 보관하면서 tab_configs 행을
--   지웠다. 그 행에 [리뷰]·[구매캡처] 폴더 주소가 있었으므로 보관된 작업 602건은 작업보드에서
--   「구매 캡처」「리뷰 캡처」 폴더 바로가기가 영영 꺼졌다(파일·폴더 자체는 Drive 에 그대로 있다).
-- 무엇: 보관 기록(index_master_archive)에 두 주소 칸을 더한다. tab_configs 를 되살리지 않는 이유 =
--   결정 267 — 등록행이 생기면 주기 재생성이 보관된 명단을 되살린다.
-- 채우는 것: server/scripts/backfill-archive-folder-urls.js (Drive 읽기만 · 빈 칸만 채움).
-- 읽는 것: GET /api/trackb/tab-folders?kind=info — tab_configs 행이 없을 때만 이 칸으로 접는다.
-- 가산 칸만 추가 — 기존 쓰기 경로 무변경.
-- 롤백: ALTER TABLE index_master_archive DROP COLUMN IF EXISTS folder_url, DROP COLUMN IF EXISTS capture_folder_url;
ALTER TABLE index_master_archive ADD COLUMN IF NOT EXISTS folder_url TEXT;
ALTER TABLE index_master_archive ADD COLUMN IF NOT EXISTS capture_folder_url TEXT;
