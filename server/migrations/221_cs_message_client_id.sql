-- 221: 1:1문의 다시 보내기 중복 방지 (결정 361)
--
-- 리뷰어 대화창이 쓴 글 하나마다 키(client_msg_id)를 만들어 다시 보낼 때마다 같은 키를 싣는다.
-- 시간 초과·끊김으로 응답만 못 받은 첫 전송이 이미 저장됐으면, 같은 방·같은 키의 다시 보내기는
-- 새로 저장하지 않고 저장된 메시지를 성공으로 돌려준다(POST /api/reviewer/cs/message).
--
-- ★ 더하기만 한다 — 기존 행은 전부 NULL 그대로(동작 불변), 지우기·이름 바꾸기 0.
-- ★ 두 번 돌려도 안전(IF NOT EXISTS). 기본값 없는 칸 추가라 표 재작성 없음.
-- ★ 부분 유일 색인: 키가 있는 행만 담는다 → 기존 행(NULL)·관리자 답장·카드 메시지는 색인에 들어가지 않는다.
--   유일 범위 = 문의방(thread_id) 안. 문의방은 (리뷰어 phone8, 작업) 당 하나라서 곧 「리뷰어·방마다 한 번」.
ALTER TABLE cs_messages ADD COLUMN IF NOT EXISTS client_msg_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_messages_thread_client_msg
  ON cs_messages (thread_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
