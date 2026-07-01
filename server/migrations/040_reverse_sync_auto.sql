-- 040: 시트→DB 역동기화 "무인 자동적용(constrained auto-apply)" 지원 컬럼.
-- 적대검증(레드→블루→심판) 반영: 자동적용은 (안전필드 화이트리스트) AND (apply시점 라이브 재검증)
--   AND (per-order 쿨다운=핑퐁/폭주 차단) AND (전용 락 reverse_sync_auto) 조건에서만.
-- Idempotent·additive·비파괴 → 자동머지 안전. 기본 동작 변화 없음(REVERSE_SYNC_AUTO 미설정이면 비활성).

-- per-order 쿨다운(핑퐁/폭주 hysteresis): 자동적용 직후 시각 기록. 쿨다운 창 내 재자동적용 금지.
ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS reverse_sync_last_auto_at TIMESTAMPTZ;

-- 롤백/감사: 자동적용 직전 실제 DB값(정확한 되돌리기) + 무인 자동적용 표식(수동 apply와 구분).
ALTER TABLE reverse_sync_proposals
  ADD COLUMN IF NOT EXISTS applied_old_value TEXT,
  ADD COLUMN IF NOT EXISTS auto_applied BOOLEAN NOT NULL DEFAULT FALSE;

-- 롤백 대상(자동적용 완료건) 조회 가속.
CREATE INDEX IF NOT EXISTS idx_reverse_sync_auto_applied
  ON reverse_sync_proposals (os_id)
  WHERE auto_applied = TRUE AND status = 'applied';
