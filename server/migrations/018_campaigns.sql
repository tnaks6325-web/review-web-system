-- ═══════════════════════════════════════════════════════════
-- 018: 모집공고(캠페인) 시스템 테이블
-- ═══════════════════════════════════════════════════════════

-- 캠페인(모집공고) 테이블
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY DEFAULT ('camp_' || substr(md5(random()::text), 1, 12)),
  title TEXT NOT NULL,
  channel TEXT DEFAULT '',
  channel_custom TEXT DEFAULT '',
  manager TEXT DEFAULT '',
  time_range TEXT DEFAULT '',
  delivery_type TEXT DEFAULT '',
  review_fee INTEGER DEFAULT 0,
  badges JSONB DEFAULT '[]'::jsonb,
  notes TEXT DEFAULT '',
  chat_url TEXT DEFAULT '',
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  sort_order INTEGER DEFAULT 0,
  max_slots INTEGER DEFAULT 0,
  current_slots INTEGER DEFAULT 0,
  deadline TIMESTAMPTZ,
  description TEXT DEFAULT '',
  linked_sheet_id TEXT DEFAULT '',
  linked_tab_name TEXT DEFAULT '',
  linked_tab_gid TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 캠페인 참여 신청 테이블
CREATE TABLE IF NOT EXISTS campaign_applications (
  id SERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  applicant_name TEXT NOT NULL,
  applicant_phone TEXT DEFAULT '',
  applicant_inad TEXT DEFAULT '',
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  sheet_row_added BOOLEAN DEFAULT FALSE,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, applicant_name, applicant_phone)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_sort ON campaigns(sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_apps_campaign ON campaign_applications(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_apps_name ON campaign_applications(applicant_name);
