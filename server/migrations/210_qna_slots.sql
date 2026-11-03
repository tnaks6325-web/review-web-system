-- 210: Q&A체험단 날짜별 자리표 — 사용자 확정 2026-11-03 (결정 321).
--
-- 한 줄 = 「이 날 · 이 상품(선택지) · 공개/비공개 · (공개면) 이 문구 그대로」.
-- 접수(무시트 작업표 생성) 때 작업오더에서 한 번 만든다. 작업표 줄(campaign_participants)은 이 표의
-- 사본을 칸으로 보여 줄 뿐이고, 신청 때 자리를 고르는 기준은 이 표다(작업표 날짜는 정리 작업이 옮길 수 있다).
--   seq          = 그 자리의 작업표 줄 번호(campaign_participants.seq)
--   unit_key     = 작업표 v2 선택 키(상품 · 1차옵션 · 2차옵션) — productOptions.selectionKey
--   visibility   = 'public' | 'private'
--   status       = 'open' | 'lapsed'(일정 끝에 못 채워 닫음) | 'cancelled'
-- ★ 가산 전용 · CHECK/FK 없음(082·137 규율) · 러너가 매 기동 시 재실행하므로 멱등.
-- 롤백: DROP TABLE qna_slots (코드가 먼저 되돌아가 있어야 한다 — 없는 표는 조회 실패 = Q&A 신청 차단으로 접힌다).

CREATE TABLE IF NOT EXISTS qna_slots (
  id            BIGSERIAL PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  sheet_id      TEXT NOT NULL,
  tab_name      TEXT NOT NULL,
  seq           INTEGER,
  unit_key      TEXT NOT NULL,
  product_name  TEXT NOT NULL DEFAULT '',
  option1_value TEXT NOT NULL DEFAULT '',
  option2_value TEXT NOT NULL DEFAULT '',
  unit_idx      INTEGER NOT NULL DEFAULT 0,
  unit_seq      INTEGER NOT NULL,
  slot_date     DATE NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'private',
  question_text TEXT NOT NULL DEFAULT '',
  round         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qna_slots_unit ON qna_slots (sheet_id, tab_name, unit_key, unit_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qna_slots_row  ON qna_slots (sheet_id, tab_name, seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qna_slots_day ON qna_slots (sheet_id, tab_name, slot_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_qna_slots_wo  ON qna_slots (work_order_id);
