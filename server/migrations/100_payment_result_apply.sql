-- ═══════════════════════════════════════════════════════════
-- 100: 리뷰비 입금 자동화 M2 — 이체결과 파일 반영(성공/실패 판정 · 반영 이력)
--
-- 설계 메모(되돌리기 어려운 규칙이라 여기 남긴다):
--  ★ 086 이 이미 `payment_batch_items.status`(pending|paid|failed|cancelled)·`paid_at`·`fail_reason`
--    자리를 잡아 뒀다. 100 은 **그 판정의 근거를 남기는 칸만** 더한다 —
--    은행이 실제로 뭐라고 답했는지(`result_status`)와 결과 파일 몇 번째 줄과 짝지었는지(`result_seq`).
--    근거가 없으면 나중에 "왜 실패로 봤나"를 사람이 되짚을 수 없다.
--  ★ `result_seq` 가 필요한 이유 = **같은 계좌·같은 금액이 한 회차에 2건 이상**일 때
--    결과가 엇갈리면 순서대로 배정하기로 사용자가 확정했다(2026-08-10). 그 배정이 임의라는 사실을
--    화면이 고지하고, 어느 줄에 붙었는지를 여기에 박제해 나중에 대조할 수 있게 한다.
--  ★ 컬럼 추가만 · 백필 0 = 배포 즉시 동작 100% 불변(M1 회차는 전부 NULL 로 남는다).
-- ═══════════════════════════════════════════════════════════

-- ── 회차: 반영(결과 파일 적용) 시각·주체 ──────────────────
--  status 는 086 의 CHECK 에 이미 'applied' 가 들어 있다(추가 제약 변경 없음).
ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS applied_by TEXT;

-- ── 건: 은행 결과 원문 · 짝지은 줄 번호 · 리뷰어 안내 발송 시각 ──
--  result_status = 결과 파일의 처리상태 칸 원문("처리완료"·"오류"·"이체완료"…).
--                  우리 판정(status)과 분리해 둔다 — 은행이 새 문구를 쓰면 판정은 실패로 떨어지지만
--                  원문이 남아 있어야 무엇을 못 읽었는지 알 수 있다.
--  notified_at   = 실패 안내(1:1문의)를 보낸 시각. 같은 건에 두 번 보내지 않기 위한 표식.
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS result_status TEXT;
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS result_seq    INTEGER;
ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS notified_at   TIMESTAMPTZ;

-- ── 결과 파일 업로드 이력(감사) ────────────────────────────
--  파일 자체는 저장하지 않는다(계좌·실명 원문이라 보관 표면을 늘리지 않는다).
--  남기는 것은 "언제 누가 어떤 파일을 올려 몇 건이 성공/실패로 반영됐는가" 뿐.
CREATE TABLE IF NOT EXISTS payment_result_uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      UUID REFERENCES payment_batches(id) ON DELETE CASCADE,
  bank          TEXT,                 -- 파일에서 판독한 은행(kbank|hana)
  file_name     TEXT,
  file_format   TEXT,                 -- xlsx | xls | text
  row_count     INTEGER NOT NULL DEFAULT 0,   -- 결과 파일에서 읽은 이체 줄 수
  matched       INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  applied       BOOLEAN NOT NULL DEFAULT FALSE, -- FALSE = 미리보기만(쓰기 없음)
  summary       JSONB,                -- 경고·순서배정 그룹 등 화면이 보여준 요약 그대로
  uploaded_by   TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_result_uploads_batch
  ON payment_result_uploads(batch_id, uploaded_at DESC);
