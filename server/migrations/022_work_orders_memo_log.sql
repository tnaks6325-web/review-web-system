-- 처리메모 누적 로그(전송 이력) — JSON 배열 문자열 [{memo,by,at,delivered,error}]
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS memo_log TEXT DEFAULT '';
