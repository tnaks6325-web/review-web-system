-- 114: 작업오더 리뷰비를 원장으로 보존해 모집공고 생성 폼에 자동 표시한다.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS review_fee INTEGER DEFAULT 0;
