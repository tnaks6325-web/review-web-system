-- 관리자 공지사항 테이블
CREATE TABLE IF NOT EXISTS admin_notices (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  display_days INTEGER NOT NULL DEFAULT 7,
  target_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_by VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 공지 확인 기록 테이블
CREATE TABLE IF NOT EXISTS admin_notice_reads (
  id SERIAL PRIMARY KEY,
  notice_id INTEGER NOT NULL REFERENCES admin_notices(id) ON DELETE CASCADE,
  admin_name VARCHAR(50) NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(notice_id, admin_name)
);

CREATE INDEX IF NOT EXISTS idx_admin_notices_active ON admin_notices(is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_notice_reads_lookup ON admin_notice_reads(notice_id, admin_name);
