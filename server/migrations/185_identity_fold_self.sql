-- 185: 같은 번호 타계정 정리(결정 226 3·4단계 · 사용자 확정 2026-10-13 1가·2가·3나).
--
-- 본계정과 번호가 같은 타계정 칸(이름만 다름 · 이름까지 같은 완전 중복 포함)을 본계정으로 합친다.
--   fold_self = 그 칸을 타계정 목록에서 지우고, 카드는 merged(합쳐 들어간 곳 = 본인 카드)로 표시한다.
--   그 카드로 기록된 참여·주문은 본인 카드로 옮기고, 옮긴 행은 fold_moves 에 남긴다(되돌리기용).
-- ★ 결정 179 완화 금지 ①(타계정 칸 안 지움)의 예외는 **이 유형만**이다(번호가 본계정과 같아 옛 번호 로그인 걱정이 없다).
-- ★ snapshot 에 지운 칸 전체와 순번을 담는다. 주민번호는 담지 않는다 — 대상은 주민번호가 비었거나 본계정과 같은 칸뿐이라
--   "본계정과 같음" 표시만 남기고, 되돌릴 때 본계정 값으로 채운다(166 과 같은 민감정보 복제 금지).
-- ★ 가산 전용 · 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다.

ALTER TABLE reviewer_identity_decisions ADD COLUMN IF NOT EXISTS snapshot JSONB;
ALTER TABLE reviewer_identity_decisions ADD COLUMN IF NOT EXISTS notice_dismissed_at TIMESTAMPTZ;

-- 종류 허용값에 fold_self 추가(이름은 167 의 기본 이름). 이미 들어 있으면 건너뛴다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.reviewer_identity_decisions'::regclass
       AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%fold_self%'
  ) THEN
    ALTER TABLE reviewer_identity_decisions DROP CONSTRAINT IF EXISTS reviewer_identity_decisions_kind_check;
    ALTER TABLE reviewer_identity_decisions ADD CONSTRAINT reviewer_identity_decisions_kind_check
      CHECK (kind IN ('merge', 'keep_separate', 'shared_phone_ok', 'fold_self'));
  END IF;
END $$;

-- 본계정 로그인 팝업이 그 소유자의 열린 정리 판단만 빨리 찾게.
CREATE INDEX IF NOT EXISTS idx_identity_decisions_fold_owner
  ON reviewer_identity_decisions (owner_reviewer_id)
  WHERE kind = 'fold_self' AND undone_at IS NULL;

-- 정리로 옮긴 참여·주문 행(되돌리기는 "지금 값이 우리가 쓴 값일 때만" 되돌린다).
CREATE TABLE IF NOT EXISTS reviewer_identity_fold_moves (
  id           BIGSERIAL PRIMARY KEY,
  decision_id  BIGINT NOT NULL REFERENCES reviewer_identity_decisions(id) ON DELETE CASCADE,
  table_name   TEXT NOT NULL CHECK (table_name IN ('order_submissions', 'campaign_applications')),
  row_id       TEXT NOT NULL,
  old_card_id  UUID,
  new_card_id  UUID,
  old_hash     TEXT,
  new_hash     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_identity_fold_moves_decision ON reviewer_identity_fold_moves (decision_id);

-- 스위치 실행 기록(미리보기·실행·전부 되돌리기). items 에는 소유자 번호·칸 순번·사유만(이름·번호 금지).
CREATE TABLE IF NOT EXISTS reviewer_identity_fold_runs (
  id           BIGSERIAL PRIMARY KEY,
  mode         TEXT NOT NULL CHECK (mode IN ('preview', 'apply', 'undo_all')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  summary      JSONB NOT NULL DEFAULT '{}',
  items        JSONB NOT NULL DEFAULT '[]'
);
