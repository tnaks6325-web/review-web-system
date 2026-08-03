-- 080: C/S 메시지 카드형(구조화) 지원 — 리뷰이미지 교체요청 연동
--
-- 지금 cs_messages 에는 content(텍스트)와 image_urls(URL 배열)뿐이라
-- "기존↔변경 이미지 + 승인/반려 버튼" 같은 카드를 담을 칸이 없다.
-- content 문자열에 인코딩하는 방법도 있지만 ① 리뷰어에게 그대로 escape 되어 보이고
-- ② 상태(pending→approved)를 제자리에서 갱신할 수 없어 카드가 여러 장으로 늘어난다.
-- → 타입 + 메타 두 칸을 더한다. 기존 메시지는 전부 'text'/'{}' 로 남아 동작 불변.
--
-- ※ migrate.js 가 매번 전체 .sql 을 재실행하므로 반드시 idempotent.

-- 상수 기본값이라 테이블 재작성 없음(PG11+).
ALTER TABLE cs_messages ADD COLUMN IF NOT EXISTS msg_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE cs_messages ADD COLUMN IF NOT EXISTS meta     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 값 공간을 좁혀 둔다 — 프론트가 모르는 타입을 받으면 렌더가 비어 버린다.
--   'text'        : 기존 일반 메시지(기본값)
--   'review_edit' : 리뷰이미지 교체요청 카드(meta.requestId 로 원장과 연결)
-- ★ NOT VALID — 기존 행 전체 스캔을 생략한다. 방금 추가한 컬럼이라 기존 행은 전부
--   DEFAULT 'text' 여서 제약을 자명하게 만족하고, 신규/갱신 행에는 그대로 적용된다.
--   (러너가 파일 하나를 암묵 트랜잭션으로 실행하므로, 스캔을 넣으면 그동안
--    ACCESS EXCLUSIVE 락이 유지되어 cs_messages 읽기·쓰기가 전부 멈춘다.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cs_messages_msg_type_chk'
  ) THEN
    ALTER TABLE cs_messages
      ADD CONSTRAINT cs_messages_msg_type_chk CHECK (msg_type IN ('text', 'review_edit')) NOT VALID;
  END IF;
END $$;

-- 교체요청 1건 ↔ 카드 1장. 승인/반려는 **이 카드를 제자리에서 갱신**하고,
-- 통지는 별도 text 메시지로 보낸다(리뷰어 채팅에 알림이 뜨도록).
-- ★ 부분 유니크 = 재요청·중복 삽입이 카드를 두 장 만들지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_msg_review_edit
  ON cs_messages ((meta->>'requestId'))
  WHERE msg_type = 'review_edit';

-- 카드만 골라 보는 조회(전용 탭·대화창)용
CREATE INDEX IF NOT EXISTS idx_cs_messages_type ON cs_messages(msg_type) WHERE msg_type <> 'text';
