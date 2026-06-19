-- ═══════════════════════════════════════════════════════════
-- 030: 리뷰어 마스터에 입금받을 계좌정보 저장
--
-- 배경: 계좌정보(은행/계좌번호/예금주)를 구매양식 제출 시마다 새로 입력받아
--       오타로 계좌번호가 틀리는 사고가 발생함.
--       → 리뷰어 마스터(reviewers)에 계좌를 저장하고 구매양식에서 자동완성하여
--         재입력을 줄이고 오류를 방지한다. (입금처리 화면의 진실 원천)
-- 비파괴적: 컬럼 추가만, 기존 행은 NULL로 시작.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS bank_name      TEXT;  -- 은행명 (예: KEB하나)
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS bank_account   TEXT;  -- 계좌번호
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS account_holder TEXT;  -- 예금주명
