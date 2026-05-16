-- 015: 기존 단축링크 pyvevz에 차수(round) 정보 업데이트
-- 유일기획1-4차 캠페인의 shortlink로, round='1-4차'로 설정
-- 이전 014에서 컬럼만 추가되고 데이터가 업데이트되지 않은 케이스 대응

UPDATE short_links SET round = '1-4차' WHERE code = 'pyvevz' AND (round IS NULL OR round = '');
