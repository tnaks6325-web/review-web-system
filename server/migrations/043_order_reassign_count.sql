-- 043: 버그1(가드 반복차단 시 재배정 횟수 상한) — 무한 하단 append 종결용 카운터.
-- 추가 전용·idempotent·비파괴. 'stuck_manual'은 mirror_status TEXT(CHECK 없음, 035:47)라 스키마 변경 불필요.
ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS reassign_count INTEGER NOT NULL DEFAULT 0;
