-- ═══════════════════════════════════════════════════════════
-- 033: 시트 행 점유 락 (sheet_row_claims) — 중복 증식 + 행 덮어쓰기 방지
--
-- 배경(2026-06-25 사고): 아침 제출 폭주 → 구글 Sheets Read 쿼터 초과 →
--   빈행 탐색 읽기 타임아웃 → 백그라운드 큐(order_append) 적체. 큐 경로에는
--   중복 차단이 전혀 없어 재제출/타임아웃 수만큼 행이 증식했고(중복 14.6%),
--   3분 캐시 기반 빈행 탐색의 동시 경합으로 같은 빈 행(예: 58번)을 여러 제출이
--   덮어썼다("동시 제출 감지" 누적 276회).
--
-- 해결: 시트에 쓰기 전 DB에서 "행"을 원자적으로 점유한다.
--   - UNIQUE(sheet_id, tab_name, sheet_row)  → 두 주문이 같은 행 점유 불가 (덮어쓰기 방지)
--   - UNIQUE(sheet_id, tab_name, dedup_key)  → 한 주문이 두 행 점유 불가 (중복 증식 방지)
--   인라인 쓰기·큐 재시도 양쪽이 같은 dedup_key로 같은 행을 재사용 → 멱등.
--
-- dedup_key: 주문번호(숫자 6자리+) 우선, 없으면 "수취인|연락처8|날짜".
-- 비파괴적: 신규 테이블 생성만. 시트가 여전히 원본(이 테이블은 점유 힌트).
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sheet_row_claims (
  id          BIGSERIAL PRIMARY KEY,
  sheet_id    TEXT NOT NULL,
  tab_name    TEXT NOT NULL,
  sheet_row   INTEGER NOT NULL,        -- 점유한 시트 행 번호 (1-based)
  dedup_key   TEXT NOT NULL,           -- 주문 식별 키 (num:... 또는 rcp:...)
  name        TEXT,                    -- 점유 당시 리뷰어/주문자 이름 (디버그용)
  phone8      TEXT,                    -- 점유 당시 연락처 끝 8자리 (디버그용)
  source      TEXT DEFAULT 'order_submit',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 행 단위 유니크: 같은 (시트,탭,행)은 단 하나의 주문만 점유
CREATE UNIQUE INDEX IF NOT EXISTS uq_sheet_row_claims_row
  ON sheet_row_claims (sheet_id, tab_name, sheet_row);

-- 주문 단위 유니크: 같은 (시트,탭,주문키)는 단 하나의 행만 점유 (중복 증식 차단)
CREATE UNIQUE INDEX IF NOT EXISTS uq_sheet_row_claims_dedup
  ON sheet_row_claims (sheet_id, tab_name, dedup_key);
