-- 214: 블랙리스트 → 공고별 「참여 불가」 한 번 맞추기 (결정 050 개정 · 사용자 확정 2026-11-05 「b」)
-- 앞으로는 등록 순간(setGlobalBlacklist)·공고 생성 순간(blockBlacklistOnCampaign)에 자동으로 들어간다.
-- 이 파일은 그 전에 빠져 있던 것만 채운다 — 운영 실측(11/05 읽기 전용): 보관 안 된 공고 23곳 중 55행(작성중 53 · 게시중 1 · 마감 1).
-- ★ 가산 전용 · 멱등 — 그 공고에 이미 활성 행(허용 'allow' · 이미 차단)이 있으면 건드리지 않는다(NOT EXISTS + 부분 유니크 ON CONFLICT DO NOTHING).
-- ★ 보관(archived_at)된 공고는 대상 아님. 문구 = 'closed'(「마감」 — 기존 차단과 같음).
-- 롤백: UPDATE campaign_reviewer_gates SET released_at = NOW(), released_by = 'rollback 214'
--        WHERE created_by = 'migration 214 · 블랙리스트 자동' AND released_at IS NULL;
INSERT INTO campaign_reviewer_gates (campaign_id, phone8, reviewer_name, mode, message_type, created_by)
SELECT c.id, b.p8, b.name, 'block', 'closed', 'migration 214 · 블랙리스트 자동'
  FROM recruit_campaigns c
 CROSS JOIN (
   SELECT DISTINCT ON (p8) p8, LEFT(COALESCE(name, ''), 40) AS name
     FROM (SELECT RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 8) AS p8, name, added_at FROM blacklist) x
    WHERE LENGTH(p8) = 8
    ORDER BY p8, added_at DESC
 ) b
 WHERE c.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM campaign_reviewer_gates g
                    WHERE g.campaign_id = c.id AND g.phone8 = b.p8 AND g.released_at IS NULL)
ON CONFLICT DO NOTHING;
