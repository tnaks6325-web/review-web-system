-- 088: 리뷰웹시스템[3버전] 작업 "마감"(전사 공통) — 화면 분류 전용 상태.
--   배경 = 직원이 구글시트를 브라우저 탭으로 열어두고 끝난 시트는 뒤로 보내던 워크플로우를 작업보드로 옮긴다.
--     작업보드에는 **진행 중인 작업만** 남기고, 마감한 작업은 홈의 "마감 보관함"으로 분리한다.
--   설계 = PRD frontend/docs/prd-workboard-worktabs.html (v1.2, 사용자 확정).
--
-- ★★ 이것은 "화면 분류"일 뿐이다 — 구글시트·리뷰어 화면·검색·인덱스·주문 경로 무접촉.
--    그래서 되돌리기(진행중 복귀)가 클릭 한 번이고, Track A 의 tab_configs.is_closed 를 재사용하지 않는다:
--    그 플래그는 /api/tab/options 등 **기존 소비처의 동작을 바꾸므로** "화면 분류일 뿐"이라는 이 계약과 충돌한다.
--    Track B 3원칙(추가만·읽기만·격리) 준수 — 되돌리기 = 라우트 미마운트 + DROP TABLE.
--
-- ★ 복귀는 소프트 삭제(deleted_at) — 이력을 남긴다("언제 마감했다가 언제 되돌렸나"가 감사 재료).
--   활성 마감은 (sheet_id, tab_name) 당 1건뿐(부분 유니크) → 중복 마감 행이 생길 수 없다.
-- ★ inspect_confirmed_at = 마감 확인창의 "리뷰폴더 마감자료 검수 확인" 체크 시각(사용자 확정 ㉠).
--   검수는 캡처 품질 판단이라 시스템 수치로 대신할 수 없어 사람의 확인을 박제한다(책임추적).
CREATE TABLE IF NOT EXISTS trackb_tab_finished (
  id                   BIGSERIAL PRIMARY KEY,
  sheet_id             TEXT NOT NULL,
  tab_name             TEXT NOT NULL,
  tab_gid              TEXT,
  finished_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_by          TEXT NOT NULL DEFAULT '',
  inspect_confirmed_at TIMESTAMPTZ,                  -- 검수 확인 체크 시각(마감 시 필수)
  deleted_at           TIMESTAMPTZ,                  -- 진행중 복귀 시각
  reopened_by          TEXT                          -- 복귀시킨 사람
);

-- 활성 마감은 탭당 1건(코드 실수로도 중복 마감 불가)
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_tab_finished_active
  ON trackb_tab_finished (sheet_id, tab_name) WHERE deleted_at IS NULL;

-- 보관함 정렬(최근 마감 순)
CREATE INDEX IF NOT EXISTS idx_trackb_tab_finished_at
  ON trackb_tab_finished (finished_at DESC) WHERE deleted_at IS NULL;
