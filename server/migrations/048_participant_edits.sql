-- 048: Track B 편집 오버레이 원장 (통합 작업대 편집 가능) — 오버레이-only · read-time 합성 · append-only.
-- ★ 가산적·비파괴·shadow: 신규 테이블만. campaign_participants 물리컬럼 절대 미변경(재투영이 편집을 못 덮음).
--   되돌리기 = 라우트 미마운트 + 이 테이블 DROP. 모든 문장 IF NOT EXISTS(부팅 전량 재실행 idempotent).
--   레드-블루-심판 설계: 편집은 정렬무관 앵커(order UUID > manual 물리행 UUID > identity_key)에만 매단다.
CREATE TABLE IF NOT EXISTS participant_edits (
  id           BIGSERIAL PRIMARY KEY,
  sheet_id     TEXT NOT NULL,
  tab_name     TEXT NOT NULL,
  -- 앵커: 정렬/행이동 불변 신원키. order_submission_id(불변 UUID) > manual(물리행 UUID, 재투영 면역) > identity_key.
  --   seq(물리행) 앵커 금지 = 정렬 면역(교차노출 근본원인 회피).
  anchor_type  TEXT NOT NULL CHECK (anchor_type IN ('order','manual','identity')),
  anchor_value TEXT NOT NULL,
  field        TEXT NOT NULL,                -- 물리 컬럼명(reviewer_name/…/is_submitted/is_paid) 또는 예약 '_hidden'
  kind         TEXT NOT NULL CHECK (kind IN ('bool','text')),
  value_bool   BOOLEAN,
  value_text   TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_by  TEXT,
  reverted_at  TIMESTAMPTZ,                  -- NULL=활성. 되돌림은 append-only 이력(행 삭제 안 함).
  -- 형태 강제: bool은 value_bool 전용(캐스팅 예외 차단), text는 value_text 전용. 정확히 한쪽만 NOT NULL.
  --   (실측: to_jsonb(NULL::boolean)=SQL NULL이라 이 불변식 하에서만 COALESCE 합성이 FALSE를 보존한다.)
  CONSTRAINT participant_edits_shape CHECK (
    (kind='bool' AND value_bool IS NOT NULL AND value_text IS NULL) OR
    (kind='text' AND value_text IS NOT NULL AND value_bool IS NULL)
  )
);

-- 활성 오버레이 유일: 한 (앵커, 필드)에 활성 편집 1개(동시편집 레이스 backstop). 되돌린 이력은 유니크 대상 아님.
CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_edits_active
  ON participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field)
  WHERE reverted_at IS NULL;

-- 합성 조회 가속: 탭의 활성 오버레이 일괄 로드.
CREATE INDEX IF NOT EXISTS idx_participant_edits_tab
  ON participant_edits (sheet_id, tab_name) WHERE reverted_at IS NULL;
