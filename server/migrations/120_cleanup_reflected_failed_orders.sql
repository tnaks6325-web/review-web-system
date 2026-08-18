-- 120: 무시트 전환 중 작업보드에는 정상 기록됐지만 실패 상태로 남은 주문원장을 정리한다.
-- 안전 조건: 가상 campaign: 주문 + 실패 상태 + 같은 전화번호/모집공고/주문번호를 가진 작업보드 행.
-- 물리 삭제 대신 취소(soft delete) 처리해 감사·복구 경로는 보존한다.
UPDATE order_submissions os
   SET deleted_at = NOW(),
       canceled_by = 'sheetless_reflected_order_cleanup',
       mirror_status = 'canceled',
       updated_at = NOW()
 WHERE os.deleted_at IS NULL
   AND os.sheet_id LIKE 'campaign:%'
   AND os.mirror_status IN ('failed', 'stuck_manual')
   AND EXISTS (
     SELECT 1
       FROM campaign_applications ca
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
       JOIN review_index ri
         ON ri.phone8 = RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8)
        AND ri.tab_name = rc.title
      WHERE ca.id = os.campaign_application_id
        AND COALESCE(NULLIF(ri.row_json->>'주문번호', ''), '') <> ''
   );
