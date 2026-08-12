-- 105: 현금영수증 발행 여부를 모집공고의 직접 설정으로 보관한다.
-- 무시트 작업오더는 tab_configs.income_type가 없으므로, 탭 설정 파생만으로는
-- 리뷰어 카드·구매 안내가 사라진다. 기본 FALSE는 기존 공고의 동작을 바꾸지 않는다.
ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS cash_receipt_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_recruit_campaigns_cash_receipt_required
  ON recruit_campaigns(cash_receipt_required)
  WHERE cash_receipt_required = TRUE;
