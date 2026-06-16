-- 026_portal.sql
-- 범용 광고주 업무포털: 거래처(광고주) → 작업(캠페인) 관리 + 양사 코멘트 + 광고주 로그인
-- ※ 서버 부팅 시 _migrations 이력추적으로 1회 적용. 안전을 위해 idempotent 유지.

-- 1) 거래처(광고주) — 최상위, 범용 (어니스트캄도 이 중 하나의 거래처)
CREATE TABLE IF NOT EXISTS advertisers (
  id          TEXT PRIMARY KEY,                 -- 'adv_' + randomBytes(6).hex
  name        TEXT NOT NULL UNIQUE,             -- 거래처(광고주)명
  status      TEXT NOT NULL DEFAULT 'active'    -- 대행중/종료/확인중
              CHECK (status IN ('active','ended','pending')),
  inad_pm     TEXT DEFAULT '',                  -- 인애드 담당(AE)
  contact     TEXT DEFAULT '',                  -- 연락처/담당자 메모
  memo        TEXT DEFAULT '',
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advertisers_status ON advertisers(status);

-- 2) 광고주 로그인 계정 (거래처 연결) — staff_users 구조 미러 + advertiser_id
CREATE TABLE IF NOT EXISTS advertiser_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id TEXT NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE,
  pw_hash       TEXT NOT NULL,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advertiser_users_adv ON advertiser_users(advertiser_id);

-- 3) 작업(캠페인) — 거래처 소속, 단일 진실원천
CREATE TABLE IF NOT EXISTS portal_works (
  id              TEXT PRIMARY KEY,             -- 'pw_' + randomBytes(6).hex
  seq             SERIAL,                       -- 번호(표시용 일련번호)
  advertiser_id   TEXT NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  brand           TEXT DEFAULT '',              -- 선택: 멀티브랜드 하위 그룹(어니스트캄→굿데이허니 등)
  inad_manager    TEXT DEFAULT '',              -- 인애드 담당
  work_type       TEXT DEFAULT '',              -- 유가리뷰/바이럴/트래픽
  product         TEXT DEFAULT '',              -- 상품
  channel         TEXT DEFAULT '',              -- 채널/작업구분
  round           TEXT DEFAULT '',              -- 차수
  qty             INTEGER DEFAULT 0,            -- 건수
  progress_date   DATE,                         -- 진행일
  work_sheet_url  TEXT DEFAULT '',              -- 작업시트링크(외부)
  progress_status TEXT NOT NULL DEFAULT 'in_progress'    -- 진행현황
                  CHECK (progress_status IN ('planned','in_progress','done','hold','canceled')),
  -- 핵심 날짜 (정식 DATE, nullable → 미완료=NULL 로 집계)
  closing_date    DATE,                         -- 마감자료완료일
  quote_date      DATE,                         -- 견적서완료일
  invoice_date    DATE,                         -- 세금계산서 발급일
  payment_date    DATE,                         -- 입금일
  -- 정산 (금액 BIGINT, 단위: 원)
  total_cost      BIGINT DEFAULT 0,             -- 총비용
  deposit         BIGINT DEFAULT 0,             -- 선금
  deposit_date    DATE,
  balance         BIGINT DEFAULT 0,             -- 잔금
  balance_date    DATE,
  group_ref       TEXT DEFAULT '',              -- 합산/상동 비용 중복합산 방지 키
  note_inad       TEXT DEFAULT '',              -- 비고(인애드)
  note_client     TEXT DEFAULT '',              -- 비고(광고주)
  status          TEXT NOT NULL DEFAULT 'active'   -- 레코드 상태
                  CHECK (status IN ('active','archived')),
  created_by      TEXT DEFAULT '',
  deleted_at      TIMESTAMPTZ,                  -- 소프트삭제 (work_orders 패턴)
  deleted_by      TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_works_adv     ON portal_works(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_portal_works_status  ON portal_works(progress_status);
CREATE INDEX IF NOT EXISTS idx_portal_works_created ON portal_works(created_at DESC);

-- 4) 양방향 코멘트 / 확인요청 (인애드 ↔ 광고주)
CREATE TABLE IF NOT EXISTS portal_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id       TEXT REFERENCES portal_works(id) ON DELETE CASCADE,
  advertiser_id TEXT REFERENCES advertisers(id) ON DELETE CASCADE,
  side          TEXT NOT NULL DEFAULT 'inad'   -- inad(인애드) / client(광고주)
                CHECK (side IN ('inad','client')),
  author        TEXT DEFAULT '',
  content       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'comment'
                CHECK (kind IN ('comment','confirm_request')),
  resolved      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_comments_work ON portal_comments(work_id);
CREATE INDEX IF NOT EXISTS idx_portal_comments_adv  ON portal_comments(advertiser_id);
