-- 093: 검수 결과 메시지(사진 카드) — cs_messages.msg_type 에 'inspect_result' 허용.
--   중복 반려·이동 안내를 리뷰어 채팅에 보낼 때 "어떤 작업의 어떤 사진인지"를 보여주려면
--   교체요청 카드(review_edit)와 같은 방식(meta + 파일ID)이 필요하다.
-- ★ CHECK 만 넓힌다(테이블·인덱스 무변경). NOT VALID 로 기존 행 스캔 없이 붙인다
--   — 080 이 같은 이유로 NOT VALID 를 썼다(스캔 중 ACCESS EXCLUSIVE 유지 방지).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cs_messages_msg_type_chk') THEN
    ALTER TABLE cs_messages DROP CONSTRAINT cs_messages_msg_type_chk;
  END IF;
  ALTER TABLE cs_messages
    ADD CONSTRAINT cs_messages_msg_type_chk
    CHECK (msg_type IN ('text', 'review_edit', 'inspect_result')) NOT VALID;
END $$;
