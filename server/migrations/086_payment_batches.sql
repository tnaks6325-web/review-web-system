-- ═══════════════════════════════════════════════════════════
-- 086: 리뷰비 입금 자동화 M1 — 입금대상 추출 · 은행별 분류 · 회차(다운로드) 기록
--
-- 설계 메모(되돌리기 어려운 규칙이라 여기 남긴다):
--  ★ 이체 단위는 **A안 = 건별**(시트 행 1개 = 이체 1줄). 합산하지 않는다.
--    그래서 항목 키가 (sheet_id, tab_name, row_index) 이고, 결과 파일과 1:1로 대조된다.
--  ★ 이중입금 방지는 **DB 부분유니크**가 구조적으로 보장한다(코드 실수로 뚫리지 않게):
--    살아있는 항목(pending/paid)이 있는 행은 다시 회차에 담길 수 없다.
--    잠금이 풀리는 경로는 딱 둘 — 회차 취소(cancelled) · 이체 실패 판정(failed, M2).
--  ★ recruit_campaigns.id 는 **TEXT**(018:9)다. FK 컬럼도 TEXT 여야 한다 —
--    082 에서 UUID 로 선언했다가 42804 로 파일 전체가 롤백된 사고가 있었다.
-- ═══════════════════════════════════════════════════════════

-- ── 공고별 이체 설정 ──────────────────────────────────────
--  transfer_bank: 'kbank' | 'hana' | NULL(=자동 판정: 작업오더 물건비 수취방식)
--    · 현금이체  → 하나은행(hana)
--    · 수수료(세금계산서) → 케이뱅크(kbank)
--    NULL 이면 연결 작업오더에서 파생하고, 값이 있으면 **사람이 정한 값이 항상 우선**.
--  transfer_memo: 받는분 통장표시(리뷰어 통장에 찍히는 이름). 예) 파우더망고
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS transfer_bank TEXT;
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS transfer_memo TEXT;

-- ── 이체 회차(다운로드 1회 = 1행) ─────────────────────────
CREATE TABLE IF NOT EXISTS payment_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             BIGSERIAL,                       -- 화면 표기용 회차번호(#124)
  bank            TEXT NOT NULL,                   -- kbank | hana
  status          TEXT NOT NULL DEFAULT 'downloaded',  -- downloaded | cancelled | applied(M2)
  item_count      INTEGER NOT NULL DEFAULT 0,
  total_amount    BIGINT  NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 재다운로드도 이력에 남긴다(사용자 확정 규칙).
  -- 회차 생성 시점엔 0 — 파일을 실제로 내려받을 때만 오른다(생성만 하고 안 받은 회차 구분).
  download_count      INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at  TIMESTAMPTZ,
  last_downloaded_by  TEXT,
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    TEXT,
  CONSTRAINT ck_payment_batches_bank   CHECK (bank IN ('kbank','hana')),
  CONSTRAINT ck_payment_batches_status CHECK (status IN ('downloaded','cancelled','applied'))
);
CREATE INDEX IF NOT EXISTS idx_payment_batches_created ON payment_batches(created_at DESC);

-- ── 회차에 담긴 건(= 이체 1줄) ────────────────────────────
--  금액·통장표시·계좌는 **그때 보낸 값을 그대로 박제**한다(스냅샷).
--  나중에 리뷰비 규칙이나 공고 통장표시를 바꿔도 과거 입금 표기가 흔들리지 않는다
--  (기간별 리뷰비 사고와 같은 함정 — 화면에서 다시 계산하지 않는다).
CREATE TABLE IF NOT EXISTS payment_batch_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  row_index       INTEGER NOT NULL,
  campaign_id     TEXT REFERENCES recruit_campaigns(id) ON DELETE SET NULL,  -- ★ TEXT(018)
  reviewer_name   TEXT,
  phone8          TEXT,
  bank_name       TEXT,          -- 리뷰어가 등록한 은행명 원문
  bank_code       TEXT,          -- 표준 3자리 코드(하나은행 서식용)
  bank_account    TEXT,          -- 숫자만
  account_holder  TEXT,
  product_price   INTEGER NOT NULL DEFAULT 0,
  review_fee      INTEGER NOT NULL DEFAULT 0,
  amount          INTEGER NOT NULL,
  transfer_memo   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed | cancelled
  paid_at         TIMESTAMPTZ,   -- M2: 결과 파일의 실제 이체시점
  fail_reason     TEXT,          -- M2: 내부 표기(리뷰어에겐 미노출)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_payment_items_status CHECK (status IN ('pending','paid','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_payment_items_batch ON payment_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_items_row   ON payment_batch_items(sheet_id, tab_name, row_index);

-- ★★ 이중입금 방지의 최종 방어선(완화 금지)
--   살아있는 항목(pending=이체 대기 / paid=입금완료)이 있는 행은 새 회차에 담기지 않는다.
--   cancelled(회차 취소)·failed(이체 실패)는 제외되므로 자동으로 다시 대상이 된다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_items_active
  ON payment_batch_items(sheet_id, tab_name, row_index)
  WHERE status IN ('pending','paid');
