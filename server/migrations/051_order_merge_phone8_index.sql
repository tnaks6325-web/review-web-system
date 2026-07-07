-- 051: order_submissions 병합(A안, /api/search '구매양식 반영중' 배지) 무인증 핫패스용 부분 표현식 인덱스
--
-- 배경: /api/search(searchByName)는 무인증 고빈도 엔드포인트다. 여기에 order_submissions를
--   RIGHT(regexp_replace(phone,…),8)=ANY(phoneList) 로 병합하면 phone 표현식 인덱스가 없어
--   원장 전체 seq scan → 익명 반복 호출 시 DB 부하/pool 고갈(라이브 주문제출 굶음) 위험(레드팀 R1).
--
-- 방어: 병합 쿼리 WHERE와 "문자 그대로 동일"한 predicate(부분 인덱스)를 만들어 planner가 선택하게 한다.
--   ★ search.service.js 의 _mergeOrderSubmissions 쿼리 WHERE 의 deleted_at/mirror_status 리터럴이
--     이 인덱스 predicate 와 정확히 일치해야 partial index 가 매칭된다(파라미터 배열이면 매칭 실패).
--
-- 표현식 IMMUTABLE 확인: RIGHT/regexp_replace(text,text,text,text)/COALESCE 모두 immutable → 표현식 인덱스 가능.
-- 비-CONCURRENTLY: 기존 관례(036의 order_submissions 부분 인덱스 idx_os_alive_stuck 도 동일 방식)와 일치.
--   migrate.js 가 파일을 단일 pool.query 로 실행하므로 CONCURRENTLY 는 트랜잭션 제약이 있어 회피.
-- 롤백: DROP INDEX IF EXISTS idx_order_submissions_phone8_active;
CREATE INDEX IF NOT EXISTS idx_order_submissions_phone8_active
  ON order_submissions ((RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 8)))
  WHERE deleted_at IS NULL
    AND mirror_status IN ('pending', 'queued', 'pending_no_row', 'written', 'failed', 'stuck_manual');
