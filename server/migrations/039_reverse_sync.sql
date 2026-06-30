-- 039: 시트→DB 역동기화(옵션·수동·기본 OFF) — 제안 감사테이블 + 쓰기 provenance.
-- 적대검증(레드→블루→심판) 최종설계 반영. Idempotent·additive·비파괴 → 자동머지 안전.
-- 기본 동작 변화 없음: SHEET_REVERSE_SYNC 미설정이면 detect/apply 라우트가 403, 정방향 흐름 무영향.

-- R1 루프차단/노이즈억제: DB가 "마지막으로 시트에 쓴 매핑칸 값"의 서명(해시 문자열).
--   정방향 written 시점에 기록 → detect가 "현재 시트값 == 내가 쓴 값"이면 내 흔적으로 보고 제외.
ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS last_sheet_write_sig TEXT;

-- R8 감사/멱등: 역동기 "제안" 원장. 자동 쓰기 없음 — 적용은 사람 명시 클릭(reverse-sync-apply).
CREATE TABLE IF NOT EXISTS reverse_sync_proposals (
  id                BIGSERIAL PRIMARY KEY,
  os_id             UUID NOT NULL,
  sheet_id          TEXT NOT NULL,
  tab_name          TEXT NOT NULL,
  tab_gid           TEXT,
  sheet_row         INTEGER NOT NULL,
  proposal_type     TEXT NOT NULL DEFAULT 'edit',   -- 'edit' | 'cancel_suspect'
  field             TEXT,                            -- edit 대상 컬럼(cancel_suspect=NULL)
  old_value         TEXT,                            -- DB 현재값(정방향이 쓴 값)
  new_value         TEXT,                            -- 시트 현재값(사람이 고친 값)
  detected_sig      TEXT,                            -- 감지 시점 시트행 서명(참고)
  detected_edit_seq BIGINT,                          -- G6: 감지 시점 last_edit_seq(apply 시 불변 확인)
  status            TEXT NOT NULL DEFAULT 'open',    -- 'open' | 'applied' | 'dismissed'
  detected_at       TIMESTAMPTZ DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT
);

-- G2: 부분유니크 ON CONFLICT 대신 detect가 "open 제안 교체(DELETE→INSERT)"로 멱등.
--   조회 가속용 일반(부분) 인덱스만 — 유니크 강제 안 함.
CREATE INDEX IF NOT EXISTS idx_reverse_sync_open_tab
  ON reverse_sync_proposals (sheet_id, tab_name) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_reverse_sync_open_os
  ON reverse_sync_proposals (os_id) WHERE status = 'open';
