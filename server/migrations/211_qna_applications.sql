-- 211: Q&A체험단 3단계 — 신청 ↔ 날짜별 자리 묶기 (결정 321 · 사용자 확정 2026-11-03 「전부 권장」).
--
-- 신청하는 순간 그 상품의 **오늘 빈 자리 하나**가 그 신청에 묶인다(campaign_applications.qna_slot_id).
--   자리가 비었는지 = 이 자리를 가리키는 신청이 「제출 완료」이거나 「유효한 홀드(마감 전)」가 아님.
--   그래서 자리표(qna_slots.status)는 신청·만료·취소 때 고치지 않는다 — 신청 표가 단일 출처다.
-- ★ 한 자리에 두 신청이 묶이지 않게 부분 유일 색인(살아 있는 신청만 — 만료·취소된 신청은 자리를 놓는다).
--   마감이 지났는데 아직 스윕이 정리하지 않은 신청은 신청 경로가 고르기 직전에 그 자리에서 정리한다(campaign.routes).
-- ★ 가산 전용 · CHECK/FK 없음(082·137 규율) · 러너가 매 기동 시 재실행하므로 멱등.
-- 롤백: DROP INDEX uq_campaign_apps_qna_slot; ALTER TABLE campaign_applications DROP COLUMN qna_slot_id;
--   (코드가 먼저 되돌아가 있어야 한다 — 칸이 없으면 기동 필수 스키마 검사가 부팅을 막는다)

ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS qna_slot_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_qna_slot
  ON campaign_applications (qna_slot_id)
  WHERE qna_slot_id IS NOT NULL AND status IN ('applied', 'submitted');

COMMENT ON COLUMN campaign_applications.qna_slot_id IS 'Q&A체험단(결정 321) — 이 신청이 차지한 날짜별 자리(qna_slots.id). 리뷰·블로그 신청은 NULL.';
