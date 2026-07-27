-- 062: 참여형 캠페인 시작일 — 시작일 전에 미리 게시해도 '오픈 예정(preopen)' 카운트다운으로 표시.
-- 작업오더 work_orders.start_date(DATE, 이미 존재)를 발행 폼이 프리필하고 관리자가 확정한다.
-- NULL = 시작일 없음(게시 즉시 오픈 — 기존 공고 동작 불변).
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS start_date DATE;
