-- ═══════════════════════════════════════════════════════════
-- 034: 탭별 다중 리뷰 캡처 슬롯 + 제출원장 슬롯 구분
--
-- 배경: 1작업(행)에 캡처본이 2개 이상 필요한 경우가 있다.
--   예) 리뷰 2건, 또는 리뷰 1건 + 현금영수증 1건.
--   현재는 is_submitted 불리언 하나로 첫 제출에 완료 처리되어 보완/추가 제출이
--   불가능하고, 탭별로 "몇 건·어떤 종류"가 필요한지 지정할 방법이 없다.
--
-- 해법:
--   - tab_configs.capture_slots: 탭별 "라벨 슬롯" 목록(순서 있는 배열).
--       [{"key":"review","label":"리뷰"},{"key":"receipt","label":"현금영수증"}]
--       NULL/[] = 단일 암묵 'review' 슬롯 (기존 동작 그대로 — 완전 하위호환)
--   - review_submissions.slot_key: 업로드 파일이 어느 슬롯 제출인지 기록.
--       기존 행은 DEFAULT 'review'로 채워짐(백필 불필요).
--   완료 판정 = (탭의 필요 슬롯 집합) ⊆ (행 원장의 distinct slot_key 집합).
--
-- 비파괴적: 컬럼 추가 + 인덱스만. idempotent (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════

ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS capture_slots JSONB DEFAULT NULL;

ALTER TABLE review_submissions
  ADD COLUMN IF NOT EXISTS slot_key TEXT NOT NULL DEFAULT 'review';

CREATE INDEX IF NOT EXISTS idx_review_sub_slot
  ON review_submissions(sheet_id, tab_name, row_index, slot_key);
