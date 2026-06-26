-- ═══════════════════════════════════════════════════════════
-- 033: 작업오더 ↔ 등록된 탭 연결 (접수 시 캠페인 탭 관리 자동 반영)
--
-- 배경: 관리자가 작업오더를 "접수"하면 work_sheet_url(gid 포함)이 가리키는
--   그 탭을 캠페인 탭 관리(tab_configs)에 등록하고, 작업오더 기본정보를
--   탭 메타(manager/time_range/review_type/delivery_type/taekhap/display_name 등)에
--   자동 입력한다. 어느 탭에 연결됐는지 역추적·멱등 처리를 위해 링크 컬럼을 둔다.
--
-- 멱등/중복 방지:
--   - linked_tab_gid 가 이미 있으면 같은 작업오더 재접수 시 재등록하지 않는다.
--   - 같은 gid 탭을 가리키는 2차 작업오더는 별도 탭을 만들지 않는다(동일 탭 한 줄로 수렴).
--     차수(1차/2차) 구분은 시트의 '차수' 컬럼 → review_index.round 집계가 담당하므로
--     work_orders 에는 차수 컬럼을 두지 않는다.
--
-- 비파괴적: 컬럼 추가만(ADD COLUMN IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS linked_tab_sheet_id TEXT DEFAULT '';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS linked_tab_name     TEXT DEFAULT '';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS linked_tab_gid      TEXT DEFAULT '';
