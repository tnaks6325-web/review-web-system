-- 078: 관리자 닉네임 (1:1문의 실명 노출 차단)
--
-- 배경: C/S 1:1문의 답장은 `cs_messages.sender_name`에 로그인 계정명(=관리자 실명)을 그대로
--       기록해 왔고, 그 값이 리뷰어 대화창에 그대로 노출됐다(박세희·박은비·master).
--
-- 설계: 계정 테이블(admin_users)에 컬럼을 붙이지 않고 **로그인명 → 닉네임** 매핑 테이블 하나로 둔다.
--       마스터(env 계정)·staff·인트라넷 SSO 사용자는 admin_users 행이 없으므로, 로그인명 키가
--       모든 로그인 경로를 하나로 덮는 유일한 방법이다.
--
-- 표시 규칙(서비스에서 강제):
--   · 리뷰어 화면  = 닉네임 || '관리자'   ← 미설정이어도 실명은 절대 안 나간다(안전 기본값)
--   · 관리자 화면  = 닉네임 || 로그인명   ← 내부 책임추적은 유지
--   해석은 **읽는 시점**에 하므로 이미 쌓인 과거 메시지의 실명도 함께 가려진다.
CREATE TABLE IF NOT EXISTS admin_nicknames (
  login_name TEXT PRIMARY KEY,
  nickname   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT ''
);

-- 운영 중인 매핑 시드(utils/workManager.js의 작업담당 닉네임과 동일 값).
-- 이미 값이 있으면 건드리지 않는다(관리자가 직접 바꾼 닉네임 보존).
INSERT INTO admin_nicknames (login_name, nickname, updated_by) VALUES
  ('박세희', '만두', 'migration:078'),
  ('박은비', '망고', 'migration:078')
ON CONFLICT (login_name) DO NOTHING;
