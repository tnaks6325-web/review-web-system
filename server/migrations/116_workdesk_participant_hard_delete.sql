-- 116: 작업보드 참여자 실제 삭제 이력
--
-- 작업표의 행은 campaign_participants 에서 실제 DELETE 한다. 다만 시트/원장 재투영이
-- 같은 seq를 다시 만들거나 리뷰어 참여내역에 다시 노출시키면 "삭제"가 숨기기와 같아진다.
-- 이 테이블은 삭제된 행의 최소 식별자만 보관하는 재생성 차단·감사 표식이다.
CREATE TABLE IF NOT EXISTS workdesk_participant_deletions (
  sheet_id            TEXT NOT NULL,
  tab_name            TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  order_submission_id UUID,
  deleted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by          TEXT,
  PRIMARY KEY (sheet_id, tab_name, seq)
);

CREATE INDEX IF NOT EXISTS idx_workdesk_participant_deletions_order
  ON workdesk_participant_deletions (order_submission_id)
  WHERE order_submission_id IS NOT NULL;

-- 바로 전 버전이 남긴 논리삭제 표식은 실제 삭제 모델로 1회 승계한다.
-- 그 외 일반 soft-delete 데이터는 의미가 다를 수 있으므로 건드리지 않는다.
INSERT INTO workdesk_participant_deletions
  (sheet_id, tab_name, seq, order_submission_id, deleted_at, deleted_by)
SELECT sheet_id, tab_name, seq, order_submission_id, deleted_at, updated_by
  FROM campaign_participants
 WHERE deleted_at IS NOT NULL
   AND COALESCE(row_json->>'__workdesk_deleted', 'false') = 'true'
ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING;

DELETE FROM campaign_participants cp
 USING workdesk_participant_deletions wd
 WHERE cp.sheet_id=wd.sheet_id AND cp.tab_name=wd.tab_name AND cp.seq=wd.seq
   AND COALESCE(cp.row_json->>'__workdesk_deleted', 'false') = 'true';
