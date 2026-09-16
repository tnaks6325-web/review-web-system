-- 로그인 소유자와 실제 참여행의 불변 연결을 기존 원장에 보강한다.
-- 이름은 사용하지 않는다. 신청 시 서버가 기록한 owner_phone8이 등록리뷰어DB에서 유일한 경우와
-- 이미 연결된 신청/주문 UUID만 따라가며, 모호하거나 근거 없는 행은 기존 레거시 상태로 남긴다.

WITH registered_owner_candidates AS (
  SELECT r.phone8, r.id AS reviewer_id
    FROM reviewers r
   WHERE COALESCE(r.phone8, '') <> ''
  UNION ALL
  SELECT RIGHT(regexp_replace(COALESCE(sub->>'phone', ''), '[^0-9]', '', 'g'), 8) AS phone8,
         r.id AS reviewer_id
    FROM reviewers r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.sub_accounts) = 'array'
           THEN r.sub_accounts ELSE '[]'::jsonb END
    ) sub
   WHERE RIGHT(regexp_replace(COALESCE(sub->>'phone', ''), '[^0-9]', '', 'g'), 8) <> ''
), single_registered_owner AS (
  SELECT c.phone8, MIN(c.reviewer_id::text)::uuid AS reviewer_id
    FROM registered_owner_candidates c
   GROUP BY c.phone8
  HAVING COUNT(DISTINCT c.reviewer_id) = 1
), unique_registered_owner AS (
  SELECT c.phone8, c.reviewer_id
    FROM single_registered_owner c
   WHERE NOT EXISTS (
     SELECT 1 FROM reviewer_phone_changes rpc
      WHERE rpc.old_phone8 = c.phone8 AND rpc.reviewer_id <> c.reviewer_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM reviewer_identity_aliases ria
         JOIN reviewer_identities ri ON ri.id = ria.identity_id
        WHERE ria.phone8 = c.phone8
          AND ri.owner_reviewer_id <> c.reviewer_id
     )
)
UPDATE campaign_applications ca
   SET owner_reviewer_id = u.reviewer_id
  FROM unique_registered_owner u
 WHERE ca.owner_reviewer_id IS NULL
   AND COALESCE(ca.owner_phone8, '') <> ''
   AND ca.owner_phone8 = u.phone8;

-- participation_links.phone8은 리뷰 제출 당시 로그인 번호다. 등록DB에서 소유자가 유일할 때만
-- UUID로 승격한다. 행 이름·연락처·갱신시각은 소유권을 바꾸지 않으며 타계정 미확정 건은 본계정에 귀속한다.
WITH registered_owner_candidates AS (
  SELECT r.phone8, r.id AS reviewer_id
    FROM reviewers r
   WHERE COALESCE(r.phone8, '') <> ''
  UNION ALL
  SELECT RIGHT(regexp_replace(COALESCE(sub->>'phone', ''), '[^0-9]', '', 'g'), 8) AS phone8,
         r.id AS reviewer_id
    FROM reviewers r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.sub_accounts) = 'array'
           THEN r.sub_accounts ELSE '[]'::jsonb END
    ) sub
   WHERE RIGHT(regexp_replace(COALESCE(sub->>'phone', ''), '[^0-9]', '', 'g'), 8) <> ''
), single_registered_owner AS (
  SELECT c.phone8, MIN(c.reviewer_id::text)::uuid AS reviewer_id
    FROM registered_owner_candidates c
   GROUP BY c.phone8
  HAVING COUNT(DISTINCT c.reviewer_id) = 1
), unique_registered_owner AS (
  SELECT c.phone8, c.reviewer_id
    FROM single_registered_owner c
   WHERE NOT EXISTS (
     SELECT 1 FROM reviewer_phone_changes rpc
      WHERE rpc.old_phone8 = c.phone8 AND rpc.reviewer_id <> c.reviewer_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM reviewer_identity_aliases ria
         JOIN reviewer_identities ri ON ri.id = ria.identity_id
        WHERE ria.phone8 = c.phone8
          AND ri.owner_reviewer_id <> c.reviewer_id
     )
)
UPDATE participation_links pl
   SET owner_reviewer_id = u.reviewer_id
  FROM unique_registered_owner u
 WHERE pl.owner_reviewer_id IS NULL
   AND COALESCE(pl.phone8, '') <> ''
   AND pl.phone8 = u.phone8;

WITH historical_identity_candidates AS (
  SELECT ca.id AS application_id, a.identity_id
    FROM campaign_applications ca
    JOIN reviewer_identity_aliases a
      ON a.phone8 = ca.phone8
     AND (
       (a.valid_from <= ca.applied_at
        AND (a.valid_to IS NULL OR ca.applied_at < a.valid_to))
       OR (
         -- 코드 도입 전에 만든 신청은 bootstrap 시 생성된 최초 alias보다 오래됐다.
         -- 최초 initial alias만 과거 방향으로 열고, 아래 DISTINCT identity 검증으로
         -- 같은 소유자 안에서 번호를 공유한 다른 참여자가 있으면 백필하지 않는다.
         ca.applied_at < a.valid_from
         AND a.reason = 'initial'
         AND NOT EXISTS (
           SELECT 1 FROM reviewer_identity_aliases earlier
            WHERE earlier.identity_id = a.identity_id
              AND earlier.valid_from < a.valid_from
         )
       )
     )
    JOIN reviewer_identities i
      ON i.id = a.identity_id AND i.owner_reviewer_id = ca.owner_reviewer_id
   WHERE ca.participant_identity_id IS NULL
     AND ca.owner_reviewer_id IS NOT NULL
), unique_participant_identity AS (
  SELECT application_id, MIN(identity_id::text)::uuid AS identity_id
    FROM historical_identity_candidates
   GROUP BY application_id
  HAVING COUNT(DISTINCT identity_id) = 1
)
UPDATE campaign_applications ca
   SET participant_identity_id = i.identity_id
  FROM unique_participant_identity i
 WHERE ca.participant_identity_id IS NULL
   AND ca.id = i.application_id;

UPDATE order_submissions os
   SET owner_reviewer_id = COALESCE(os.owner_reviewer_id, ca.owner_reviewer_id),
       participant_identity_id = COALESCE(os.participant_identity_id, ca.participant_identity_id)
  FROM campaign_applications ca
 WHERE os.campaign_application_id = ca.id
   AND (os.owner_reviewer_id IS NULL OR os.participant_identity_id IS NULL)
   AND (os.owner_reviewer_id IS NULL OR os.owner_reviewer_id = ca.owner_reviewer_id)
   AND ca.owner_reviewer_id IS NOT NULL;

UPDATE order_submissions os
   SET owner_reviewer_id = COALESCE(os.owner_reviewer_id, ca.owner_reviewer_id),
       participant_identity_id = COALESCE(os.participant_identity_id, ca.participant_identity_id)
  FROM campaign_applications ca
 WHERE ca.order_submission_id = os.id
   AND (os.owner_reviewer_id IS NULL OR os.participant_identity_id IS NULL)
   AND (os.owner_reviewer_id IS NULL OR os.owner_reviewer_id = ca.owner_reviewer_id)
   AND ca.owner_reviewer_id IS NOT NULL;

UPDATE campaign_participants cp
   SET owner_reviewer_id = COALESCE(cp.owner_reviewer_id, os.owner_reviewer_id),
       participant_identity_id = COALESCE(cp.participant_identity_id, os.participant_identity_id)
  FROM order_submissions os
 WHERE cp.order_submission_id = os.id
   AND (cp.owner_reviewer_id IS NULL OR cp.participant_identity_id IS NULL)
   AND (cp.owner_reviewer_id IS NULL OR cp.owner_reviewer_id = os.owner_reviewer_id)
   AND os.owner_reviewer_id IS NOT NULL;

-- 주문/신청 연결이 없는 과거 제출행. 현재 참여행에 소유자 UUID가 없을 때 제출 로그인 소유자를
-- 복사한다. 이미 기록된 현재 참여행 소유자는 덮지 않아 충돌 시 현재 참여행을 최종 권위로 둔다.
UPDATE campaign_participants cp
   SET owner_reviewer_id = pl.owner_reviewer_id,
       participant_identity_id = COALESCE(cp.participant_identity_id, pl.participant_identity_id)
  FROM participation_links pl
 WHERE cp.owner_reviewer_id IS NULL
   AND pl.owner_reviewer_id IS NOT NULL
   AND pl.sheet_id = cp.sheet_id
   AND pl.tab_name = cp.tab_name
   AND pl.row_index = cp.seq
   AND cp.is_submitted = TRUE
   AND NOT EXISTS (
     SELECT 1
       FROM reviewers current_owner
      WHERE current_owner.id <> pl.owner_reviewer_id
        AND (
          current_owner.phone8 = cp.phone8
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(current_owner.sub_accounts) = 'array'
                     THEN current_owner.sub_accounts ELSE '[]'::jsonb END
              ) sub
             WHERE RIGHT(regexp_replace(COALESCE(sub->>'phone', ''), '[^0-9]', '', 'g'), 8) = cp.phone8
          )
        )
   )
   AND cp.deleted_at IS NULL;

UPDATE participation_links pl
   SET owner_reviewer_id = COALESCE(pl.owner_reviewer_id, cp.owner_reviewer_id),
       participant_identity_id = COALESCE(pl.participant_identity_id, cp.participant_identity_id)
  FROM campaign_participants cp
 WHERE pl.sheet_id = cp.sheet_id
   AND pl.tab_name = cp.tab_name
   AND pl.row_index = cp.seq
   AND (pl.owner_reviewer_id IS NULL OR pl.participant_identity_id IS NULL)
   AND (pl.owner_reviewer_id IS NULL OR pl.owner_reviewer_id = cp.owner_reviewer_id)
   AND cp.owner_reviewer_id IS NOT NULL
   AND cp.deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_participants_owner_active
  ON campaign_participants (owner_reviewer_id, updated_at DESC)
  WHERE owner_reviewer_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_submissions_owner_active
  ON order_submissions (owner_reviewer_id, submitted_at DESC)
  WHERE owner_reviewer_id IS NOT NULL AND deleted_at IS NULL;
