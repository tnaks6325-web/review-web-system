-- 로그인 사용자별 작업보드 표시 환경설정.
-- 보드(캠페인/탭)가 아니라 사용자에게 귀속시켜 어느 작업보드를 열어도 같은 폭을 쓴다.
CREATE TABLE IF NOT EXISTS admin_workboard_preferences (
  login_name TEXT PRIMARY KEY,
  column_widths JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admin_workboard_preferences IS
  '관리자·AE 로그인 계정별 작업보드 표시 설정. 컬럼 폭은 모든 작업보드에 공통 적용한다.';
