-- 182: 참여·주문에 "어느 명의 카드로 참여했는지"를 새긴다(신원 기준 재정립 1단계 · 결정 221).
--   기준(사용자 확정 2026-10-11): 사람 = reviewers.id · 명의 = reviewer_identity_cards.id(본인도 카드).
--   참여하는 순간 카드 번호를 기록하고, 이후 단계는 이름·번호로 다시 찾지 않고 이 번호를 따라간다.
--   ★ 칸만 더한다(NULL 허용) — 기록 실패·과거 행은 NULL 이고, 읽는 쪽은 NULL 이면 종전 방식으로 찾는다.
--   ★ 카드 행은 소유자 삭제 때만 지워진다(166 CASCADE) — 그때는 기록만 비운다(ON DELETE SET NULL).
--   ★ 외래키는 NOT VALID 로 붙인다 — 새 칸은 전부 NULL 이라 검증할 기존 행이 없다. 큰 표 전체 훑기를 피한다(레드팀 6).
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS participant_card_id UUID NULL;
ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS participant_card_id UUID NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fk_campaign_applications_participant_card'
                    AND conrelid = 'public.campaign_applications'::regclass) THEN
    ALTER TABLE campaign_applications ADD CONSTRAINT fk_campaign_applications_participant_card
      FOREIGN KEY (participant_card_id) REFERENCES reviewer_identity_cards(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fk_order_submissions_participant_card'
                    AND conrelid = 'public.order_submissions'::regclass) THEN
    ALTER TABLE order_submissions ADD CONSTRAINT fk_order_submissions_participant_card
      FOREIGN KEY (participant_card_id) REFERENCES reviewer_identity_cards(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
