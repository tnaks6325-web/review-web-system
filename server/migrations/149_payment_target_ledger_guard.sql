-- 149: 입금대상 중복 방지용 원장 조회 가속.
-- payment_records를 작업·탭·행으로 대조하고, 관리자의 나중 미입금 정정보다
-- 새로운 원장인지 paid_at으로 비교한다. 행이 없는 레거시 원장은 이 판정에 쓰이지 않으므로 제외한다.
CREATE INDEX IF NOT EXISTS idx_payment_records_target_guard
  ON payment_records (sheet_id, tab_name, row_index, paid_at DESC)
  WHERE row_index IS NOT NULL;
