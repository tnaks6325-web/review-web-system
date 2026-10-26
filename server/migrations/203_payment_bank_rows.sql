-- 203: 입금 통장 자동 대조 — 케이뱅크 거래내역(시각·금액·구분만) + 받아 온 기록 (결정 293 · 사용자 확정 2026-10-27)
-- 은행 결과 파일 없이도 회차 이체를 통장으로 확정하고, 회차 밖으로 나간 돈을 보여 주는 근거다.
-- ★ 받는 사람 이름·계좌·적요는 저장하지 않는다(대량이체 줄에는 원래 없고, 즉시이체 줄의 상대 이름도 버린다).
-- ★ 가산 전용 — 새 표 두 개. 기존 표·행 변경 0 · 백필 0 · 트리거 0.
-- 롤백: 코드를 되돌린 뒤 두 표 DROP(다른 표가 참조하지 않는다).
CREATE TABLE IF NOT EXISTS payment_bank_rows (
  bank         TEXT        NOT NULL,              -- 'kbank'
  tid          TEXT        NOT NULL,              -- 팝빌 거래 고유번호
  traded_at    TIMESTAMPTZ NOT NULL,              -- 거래 시각(초 단위)
  amount       INTEGER     NOT NULL,              -- 원(양수)
  kind         TEXT        NOT NULL,              -- bulk_out(대량이체 출금) | refund_in(취소 반환) | other_out | other_in
  balance      BIGINT,                            -- 거래 뒤 잔액(관리자 대조용)
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank, tid)
);
CREATE INDEX IF NOT EXISTS idx_payment_bank_rows_time ON payment_bank_rows (bank, traded_at);

CREATE TABLE IF NOT EXISTS payment_bank_sync (
  bank           TEXT        PRIMARY KEY,
  last_synced_at TIMESTAMPTZ,
  last_ok        BOOLEAN     NOT NULL DEFAULT FALSE,
  last_error     TEXT        NOT NULL DEFAULT '',
  range_from     DATE,
  range_to       DATE,
  row_count      INTEGER     NOT NULL DEFAULT 0,
  synced_by      TEXT        NOT NULL DEFAULT ''
);
