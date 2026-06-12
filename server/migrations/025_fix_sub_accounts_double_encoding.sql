-- 025: reviewers.sub_accounts 이중 인코딩 복구
-- 배경: 프론트가 saveSubAccounts 호출 시 subAccounts를 JSON.stringify한 문자열로
--       보내는데, 백엔드가 이를 다시 JSON.stringify하여 JSONB 컬럼에 배열이 아닌
--       "문자열 스칼라"(예: "\"[{\\\"name\\\":...}]\"")로 저장되는 버그가 있었다.
--       verifyReviewer의 타계정 매칭은 jsonb_typeof='array'인 행만 조회하므로
--       오염된 행은 타계정 로그인이 불가능했다 (화면 표시는 읽기 경로의 파싱
--       방어 코드 덕분에 정상이어서 증상이 로그인에서만 나타남).
-- 처리: 문자열 스칼라 행의 내부 텍스트를 꺼내 JSONB 배열로 캐스트한다.
--       내부 JSON이 깨진 행은 NOTICE만 남기고 건너뛴다(데이터 보존).
--       ※ migrate.js 는 매 부팅마다 전체 .sql 재실행 → 문자열 행만 갱신하므로 멱등.

DO $$
DECLARE
  r      RECORD;
  parsed JSONB;
BEGIN
  FOR r IN
    SELECT id, sub_accounts
    FROM reviewers
    WHERE jsonb_typeof(sub_accounts) = 'string'
  LOOP
    BEGIN
      parsed := (r.sub_accounts #>> '{}')::jsonb;
      -- 여러 번 중첩 인코딩된 경우도 배열이 나올 때까지 풀어준다
      WHILE jsonb_typeof(parsed) = 'string' LOOP
        parsed := (parsed #>> '{}')::jsonb;
      END LOOP;
      IF jsonb_typeof(parsed) = 'array' THEN
        UPDATE reviewers SET sub_accounts = parsed WHERE id = r.id;
      ELSE
        RAISE NOTICE 'sub_accounts 복구 건너뜀 (id=%): 배열이 아님 (%)', r.id, jsonb_typeof(parsed);
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'sub_accounts 복구 실패 (id=%): %', r.id, SQLERRM;
    END;
  END LOOP;
END $$;
