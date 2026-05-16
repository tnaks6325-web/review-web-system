-- 014: short_links 테이블에 round 컬럼 추가
-- 단축URL 생성 시 차수(round) 정보를 저장하여 resolve 시 프론트엔드에 전달

ALTER TABLE short_links ADD COLUMN IF NOT EXISTS round TEXT DEFAULT '';

-- 기존 단축링크 pyvevz에 차수 정보 추가 (유일기획1-4차)
UPDATE short_links SET round = '1-4차' WHERE code = 'pyvevz' AND (round IS NULL OR round = '');
