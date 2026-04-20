-- ============================================================
-- Phase 14: 키워드 DB 관리 + 인식 실패 탭 진단
-- ============================================================

-- 1. 인덱스 파싱 키워드 관리 테이블
CREATE TABLE IF NOT EXISTS index_keywords (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT NOT NULL,  -- 'data_tab', 'name', 'submit', 'product', 'url', 'phone', 'start_date', 'end_date', 'round', 'system_tab'
  keyword     TEXT NOT NULL,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  TEXT,
  UNIQUE(category, keyword)
);

-- 기존 하드코딩 키워드 시딩
-- DATA_TAB_KEYWORDS (헤더행 감지용)
INSERT INTO index_keywords (category, keyword) VALUES
  ('data_tab', '번호'),
  ('data_tab', '주문자'),
  ('data_tab', '수취인'),
  ('data_tab', '수취인명'),
  ('data_tab', '성함'),
  ('data_tab', '이름'),
  ('data_tab', '성명'),
  ('data_tab', '신청자'),
  ('data_tab', '연락처'),
  ('data_tab', '전화번호')
ON CONFLICT (category, keyword) DO NOTHING;

-- NAME_KEYWORDS (이름 컬럼 감지용)
INSERT INTO index_keywords (category, keyword) VALUES
  ('name', '수취인'),
  ('name', '이름'),
  ('name', '신청자'),
  ('name', '참여자'),
  ('name', '수취인명'),
  ('name', '주문자'),
  ('name', '성함'),
  ('name', '예금주'),
  ('name', '성명')
ON CONFLICT (category, keyword) DO NOTHING;

-- SUBMIT_KEYWORDS (제출 상태 컬럼 감지용)
INSERT INTO index_keywords (category, keyword) VALUES
  ('submit', '리뷰완료'),
  ('submit', '제출'),
  ('submit', '완료'),
  ('submit', 'submit'),
  ('submit', '제출완료'),
  ('submit', '리뷰제출')
ON CONFLICT (category, keyword) DO NOTHING;

-- SYSTEM_TABS (시스템 탭 제외용)
INSERT INTO index_keywords (category, keyword) VALUES
  ('system_tab', '세부목록'),
  ('system_tab', '검색인덱스'),
  ('system_tab', '인덱스마스터'),
  ('system_tab', '인덱스데이터'),
  ('system_tab', '마감'),
  ('system_tab', '상세목록'),
  ('system_tab', '탭설정'),
  ('system_tab', '설정'),
  ('system_tab', 'detail'),
  ('system_tab', 'config')
ON CONFLICT (category, keyword) DO NOTHING;

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_keywords_category ON index_keywords(category);
CREATE INDEX IF NOT EXISTS idx_keywords_active ON index_keywords(active);

-- 2. 인식 실패 탭 기록 테이블
CREATE TABLE IF NOT EXISTS unrecognized_tabs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id      TEXT NOT NULL,
  tab_name      TEXT NOT NULL,
  tab_gid       TEXT,
  campaign_name TEXT,
  sample_rows   JSONB,         -- 첫 25행 샘플 데이터
  reason        TEXT,          -- 'no_header', 'no_name_col', 'empty', 'few_rows'
  status        TEXT DEFAULT 'pending',  -- 'pending', 'ignored', 'resolved'
  ignored_by    TEXT,
  ignored_at    TIMESTAMPTZ,
  detected_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sheet_id, tab_name)
);

CREATE INDEX IF NOT EXISTS idx_unrecognized_status ON unrecognized_tabs(status);
CREATE INDEX IF NOT EXISTS idx_unrecognized_sheet ON unrecognized_tabs(sheet_id);
