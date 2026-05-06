-- 012: archived_rounds 컬럼 추가 (차수 단위 아카이브 추적)
-- 아카이브된 차수를 기록하여 스마트빌드 재삽입 및 완료감지 재표시 방지

ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS archived_rounds TEXT DEFAULT '';
