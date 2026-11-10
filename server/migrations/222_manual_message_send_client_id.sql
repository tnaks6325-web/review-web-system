-- 222: 작업보드 문자·알림톡 직접 보내기 — 다시 보내기 중복 발송 방지 (결정 364)
--
-- 담당자가 [N명에게 보내기]를 눌렀는데 서버는 이미 보냈고 응답만 못 받은 경우(시간 초과·끊김),
-- 같은 내용으로 다시 보내면 같은 문자가 한 번 더 나가 비용이 두 번 든다. 화면이 「같은 줄 선택·방식·내용」마다
-- 키(client_send_id)를 하나 만들어 다시 보낼 때마다 같은 키를 싣고, 서버는 받는 사람(참여 줄)마다
-- 공급자를 부르기 **전에** 이 표에 '대기(pending)' 줄을 먼저 넣어 한 요청만 선점하게 한다.
--
-- ★ 더하기만 한다 — 기존 행은 전부 NULL 그대로(동작 불변), 지우기·이름 바꾸기 0.
-- ★ 두 번 돌려도 안전(IF NOT EXISTS). 기본값 없는 칸 추가라 표 재작성 없음.
-- ★ 부분 유일 색인: 키가 있는 행만 담는다 → 키 없는 종전 기록(NULL)은 색인에 들어가지 않는다.
--   유일 범위 = (키, 참여 줄) = 「한 번의 발송 요청에서 한 사람에게 한 번」.
-- send_state: 'pending'(공급자 호출 전·중) | 'sent' | 'failed'(공급자가 거절 — 같은 키로 다시 보낼 수 있음)
--             | 'unknown'(시간 초과·끊김 — 받았을 수 있어 같은 키로 다시 보내지 않음)
ALTER TABLE manual_message_sends ADD COLUMN IF NOT EXISTS client_send_id TEXT;
ALTER TABLE manual_message_sends ADD COLUMN IF NOT EXISTS client_send_fp TEXT;
ALTER TABLE manual_message_sends ADD COLUMN IF NOT EXISTS send_state TEXT;
ALTER TABLE manual_message_sends ADD COLUMN IF NOT EXISTS send_state_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_message_sends_client_send
  ON manual_message_sends (client_send_id, participant_id)
  WHERE client_send_id IS NOT NULL;
