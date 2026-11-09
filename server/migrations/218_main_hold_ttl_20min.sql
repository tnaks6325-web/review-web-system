-- 218: 본계정 참여 제한시간 → 20분(결정 356 R1, 사용자 확정). 타계정(sub_hold_ttl_min=15)은 그대로.
-- ★ Q&A(qnaHoldExpiry)·블로그 승인(BLOG_PURCHASE_TTL_MIN)은 hold_ttl_min 을 쓰지 않아 영향 없다.
-- ★ campaign_applications 는 건드리지 않는다 — 이미 잡힌 자리는 잡을 때의 시간 그대로 끝난다.
-- ★ 바꾸기 전 값을 백업한다. 순서 = 백업 → UPDATE → DEFAULT(표 전체 잠금은 맨 끝에 잠깐만).
-- ★ [사용자 확인 Q1] 아래 WHERE 는 "30(옛 기본값)·비어 있음"만 바꾼다(132·133 규칙: 사람이 따로 정한 값은 덮지 않는다).
--   사용자가 "따로 정한 값(예 60분)도 20분"이라고 하면 WHERE 를 `hold_ttl_min IS DISTINCT FROM 20` 으로 바꾼다.
-- 되돌리기(사용자 승인 시에만):
--   UPDATE recruit_campaigns rc SET hold_ttl_min = b.hold_ttl_min FROM campaign_hold_ttl_backup_218 b
--    WHERE b.campaign_id = rc.id AND rc.hold_ttl_min = 20;
--   ALTER TABLE recruit_campaigns ALTER COLUMN hold_ttl_min SET DEFAULT 30;
CREATE TABLE IF NOT EXISTS campaign_hold_ttl_backup_218 (
  campaign_id  TEXT PRIMARY KEY,
  hold_ttl_min INT,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO campaign_hold_ttl_backup_218 (campaign_id, hold_ttl_min)
SELECT id, hold_ttl_min FROM recruit_campaigns
 WHERE hold_ttl_min IS NULL OR hold_ttl_min = 30
ON CONFLICT (campaign_id) DO NOTHING;
UPDATE recruit_campaigns SET hold_ttl_min = 20
 WHERE hold_ttl_min IS NULL OR hold_ttl_min = 30;
ALTER TABLE recruit_campaigns ALTER COLUMN hold_ttl_min SET DEFAULT 20;
