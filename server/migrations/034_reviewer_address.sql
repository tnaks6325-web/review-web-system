-- 034: 리뷰어 마스터에 배송/등록 주소 저장
-- 배경: 구매양식 등에서 주소를 매번 재입력하는 번거로움/오타를 줄이기 위해
--       리뷰어 본인 주소를 마스터(reviewers)에 저장한다. (타계정 주소는 sub_accounts JSON에 보관)
-- 비파괴적: 컬럼 추가만, 기존 행은 NULL로 시작.
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS address TEXT;
