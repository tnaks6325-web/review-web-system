-- 049: Track B parity 스냅샷 — 2주 관측 정량화·추이 기록.
-- ★ 가산적·비파괴·관측 전용: 신규 테이블만. 라이브(시트/주문/검색) 무관. 되돌리기 = 테이블 DROP.
--   전체 정밀 계산(수동 버튼) + 일일 크론이 투영된 전 탭의 진짜 불일치(real)·match·benign 을 배치로 적재.
CREATE TABLE IF NOT EXISTS parity_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  tab_name    TEXT NOT NULL,
  tab_gid     TEXT,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  batch_at    TIMESTAMPTZ NOT NULL,          -- 같은 배치(전체계산 1회) 공통 시각 — 배치 묶음/추이 축
  a_total     INTEGER, b_total INTEGER,
  match_cnt   INTEGER, benign_cnt INTEGER, real_cnt INTEGER,
  pass        BOOLEAN,
  source      TEXT DEFAULT 'manual'          -- manual(전체계산 버튼) | cron(일일)
);
CREATE INDEX IF NOT EXISTS idx_parity_snap_tab   ON parity_snapshots (sheet_id, tab_name, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_parity_snap_batch ON parity_snapshots (batch_at DESC);
