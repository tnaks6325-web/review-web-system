-- 208: 리뷰웹 밖 작업 이체 표시(결정 317 · 사용자 확정 2026-11-02 방식 B).
--   블로그·예약자리뷰처럼 리뷰웹에 없는 작업을 직원이 케이뱅크 대량이체 엑셀에 직접 넣어 같이 보낸다.
--   결과 파일을 놓으면 그 줄은 '미확인 이체'로 남는데, 담당자가 「리뷰웹 밖 작업」으로 표시하면 여기 기록되고
--   미확인에서 빠진다. 입금 기록(payment_records·작업보드)은 만들지 않는다 — 분류 기록일 뿐이다.
--   키 = 결과 파일 내용(sha256) + 결과 줄 번호 → 같은 파일을 다시 놓아도(업로드 줄이 새로 생겨도) 표시가 유지된다.
CREATE TABLE IF NOT EXISTS external_work_transfers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_sha256    TEXT NOT NULL,
  result_seq     INTEGER NOT NULL,
  batch_id       UUID REFERENCES payment_batches(id) ON DELETE SET NULL,
  upload_id      UUID REFERENCES payment_result_uploads(id) ON DELETE SET NULL,
  bank           TEXT NOT NULL DEFAULT '',
  work_name      TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  success        BOOLEAN NOT NULL DEFAULT TRUE,
  holder         TEXT NOT NULL DEFAULT '',
  account_tail   TEXT NOT NULL DEFAULT '',
  memo           TEXT NOT NULL DEFAULT '',
  transferred_at TIMESTAMPTZ,
  marked_by      TEXT NOT NULL DEFAULT '',
  marked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (file_sha256, result_seq)
);

CREATE INDEX IF NOT EXISTS idx_external_work_transfers_time
  ON external_work_transfers (bank, transferred_at);
CREATE INDEX IF NOT EXISTS idx_external_work_transfers_name
  ON external_work_transfers (work_name, marked_at DESC);

-- 결정 317 — 하나은행 통장 줄을 받을 때 받는 사람 이름+금액으로 맞춘 '우리 대량이체 사람'(이름 자체는 저장하지 않는다 · 결정 293).
ALTER TABLE payment_bank_rows ADD COLUMN IF NOT EXISTS matched_item_id UUID;
CREATE INDEX IF NOT EXISTS idx_payment_bank_rows_matched ON payment_bank_rows (matched_item_id) WHERE matched_item_id IS NOT NULL;
