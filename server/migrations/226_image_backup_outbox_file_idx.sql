-- 결정 368 「참조 사진」 빈틈 찾기: 리뷰 시스템이 쓰는 사진 번호 중 백업 작업이 하나도 없는 것만 고른다.
-- 그 NOT EXISTS(file_id) 비교를 색인으로 받친다. 가산 색인만 — 표·칸·기존 동작 불변. 앱/백업 코드는 이 색인 없이도
-- 정확히 동작하므로 schema 점검 목록에는 넣지 않는다(느려질 뿐 틀리지 않는다).
-- 롤백: DROP INDEX IF EXISTS image_backup_outbox_file(보존해도 무해).
CREATE INDEX IF NOT EXISTS image_backup_outbox_file ON image_backup_outbox(file_id);
