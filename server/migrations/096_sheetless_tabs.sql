-- ═══════════════════════════════════════════════════════════
-- 096: 무시트 작업 표식 (탈 구글시트 W1)
--
--  탈 구글시트 = "구글시트라는 **입력 도구**를 없앤다"이지, 시트가 남기던 장부
--  (review_index · index_master · raw_sheet_tabs/rows)를 없애는 것이 아니다(사용자 확정 D1-a = 길 B).
--  장부는 그대로 두고 **채우는 손만** 시트 → 시스템 작업표(campaign_participants)로 바꾼다.
--  → 검색·행배정·리뷰 내역·홈 통계 등 소비처 수십 곳이 **무수정**으로 그대로 동작한다.
--
--  이 플래그가 켜진 탭은:
--   ① 구글시트를 **읽지 않는다**(smartBuild·RAW 미러 스윕에서 제외 — 없는 시트를 부르면 404 반복)
--   ② 장부를 작업표에서 **생성**한다(sheetlessLedger.service)
--   ③ 시트에 **쓰지 않는다**(주문 큐 시트쓰기 대체 — W2)
--
--  ★ 탭 단위인 이유: 기존 활성 작업 이관(W5)은 **한 시트 안에서 탭별로** 진행된다.
--    같은 시트의 다른 탭이 아직 시트 기반이면 그 시트 자체는 계속 읽어야 한다.
--  ★ 컬럼 추가만 · 기본값 FALSE = 배포 즉시 동작 100% 불변(opt-in).
-- ═══════════════════════════════════════════════════════════

ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS sheetless BOOLEAN NOT NULL DEFAULT FALSE;

-- 언제·누가 끊었는지(이관 이력) + 되돌리기 판단 근거
ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS sheetless_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sheetless_by TEXT;

-- 스윕 게이트가 매 사이클 조회하므로 부분 인덱스로 좁게
CREATE INDEX IF NOT EXISTS idx_tab_configs_sheetless
  ON tab_configs (sheet_id, tab_name) WHERE sheetless = TRUE;
