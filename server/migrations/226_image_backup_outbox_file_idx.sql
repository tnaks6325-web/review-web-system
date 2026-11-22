-- 결정 368 「참조 사진」 빈틈 찾기: 리뷰 시스템이 쓰는 사진 번호 중 백업 작업이 하나도 없는 것만 고른다.
-- 그 NOT EXISTS(file_id) 비교를 색인으로 받친다. 가산 색인만 — 표·칸·기존 동작 불변. 앱/백업 코드는 이 색인 없이도
-- 정확히 동작하므로 schema 점검 목록에는 넣지 않는다(느려질 뿐 틀리지 않는다).
-- 빈틈 찾기 진도(한 줄): 시간 예산이 앞 표에서 끝나도 다음 호출이 이어서 뒤 표까지 보고, 마지막 표 뒤에는 처음으로 돈다.
-- version 은 동시 호출의 조건부 갱신(CAS)용. 이 표가 없으면 빈틈 찾기만 멈추고(BACKUP_SCHEMA_UNAVAILABLE) 백업 처리·스캔은 그대로다.
-- 롤백: DROP INDEX IF EXISTS image_backup_outbox_file; DROP TABLE IF EXISTS image_backup_referenced_cursor(보존해도 무해).
CREATE INDEX IF NOT EXISTS image_backup_outbox_file ON image_backup_outbox(file_id);
CREATE TABLE IF NOT EXISTS image_backup_referenced_cursor (
 id smallint PRIMARY KEY CHECK(id=1), source text NOT NULL DEFAULT '', after_id text NOT NULL DEFAULT '',
 version bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO image_backup_referenced_cursor(id) VALUES(1) ON CONFLICT DO NOTHING;
