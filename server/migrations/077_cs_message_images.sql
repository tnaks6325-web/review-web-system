-- 077: C/S 문의 메시지 사진 첨부
-- 리뷰어가 문의할 때 캡처/사진을 함께 보낼 수 있게 한다(관리자 답장도 동일).
-- 저장은 URL 배열만 — 파일 자체는 기존 guide-image Drive 인프라에 올리고
-- 무인증 프록시 URL(/api/order/guide-image/<id>)만 여기에 기록한다.
ALTER TABLE cs_messages ADD COLUMN IF NOT EXISTS image_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
