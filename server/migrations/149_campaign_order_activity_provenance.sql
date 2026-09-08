-- 149: 작업 로그용 주문 제출 당시 지각 provenance 보존 + 레거시 링크 조회 인덱스.
-- campaign_applications.late_order_id 는 취소 뒤 재접수를 위해 비워질 수 있으므로
-- 과거 사건 분류는 주문 원장의 불변 플래그를 사용한다.

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS campaign_was_late BOOLEAN NOT NULL DEFAULT FALSE;

-- 아직 신청 링크가 남은 기존 지각 주문을 보완한다.
UPDATE order_submissions os
   SET campaign_was_late = TRUE
  FROM campaign_applications ca
 WHERE os.campaign_was_late = FALSE
   AND ca.late_order_id = os.id;

-- 링크가 이미 지워졌더라도 마감+grace 이후임이 명확한 주문은 신청 FK로 복구한다.
UPDATE order_submissions os
   SET campaign_was_late = TRUE
  FROM campaign_applications ca
 WHERE os.campaign_was_late = FALSE
   AND os.campaign_application_id = ca.id
   AND ca.expires_at IS NOT NULL
   AND os.submitted_at > ca.expires_at + INTERVAL '30 seconds';

CREATE INDEX IF NOT EXISTS idx_campaign_apps_order_submission
  ON campaign_applications (order_submission_id)
  WHERE order_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_apps_late_order
  ON campaign_applications (late_order_id)
  WHERE late_order_id IS NOT NULL;
