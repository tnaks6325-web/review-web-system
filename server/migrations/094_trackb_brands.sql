-- 094: 브랜드 분류·화면 공유 — 대행사형 광고주의 셀프서비스 브랜드
--   (시안 frontend/docs/design-vendor-search-quotes-brands.html §3, 사용자 확정)
--   원칙: ① 브랜드 생성·작업 배정은 광고주(대행사)가 자기 화면에서 직접(관리자 개입 0)
--         ② 공유 = 브랜드별 고유 링크(기존 #adv= 프래그먼트 교환 재사용)
--         ③ 정산 정보·자료 폴더는 기본 숨김, 대행사가 브랜드별 토글로 공개
--         ④ 브랜드사 화면 브랜딩 = A안(운영사 표기 유지)
--
--   격리: 신규 테이블 2개 + 기존 테이블 무변경(무영향 3원칙 — 추가만).
--   브랜드 링크 토큰은 trackb_advertiser_links 가 아니라 brands 행에 직접 둔다
--   (브랜드:링크 = 1:1 이고, 광고주 링크의 login_required 게이트·계정 시맨틱과 분리).

CREATE TABLE IF NOT EXISTS trackb_brands (
  id                  TEXT        PRIMARY KEY,          -- 'brd_' + hex
  advertiser_id       TEXT        NOT NULL,             -- 소유 대행사(광고주)
  name                TEXT        NOT NULL,
  color               TEXT        NOT NULL DEFAULT '#2563eb',
  link_token          TEXT        UNIQUE,               -- 브랜드 열람 링크(#adv=<token> 교환)
  link_active         BOOLEAN     NOT NULL DEFAULT TRUE,   -- 링크 정지/재개(유출 대응)
  settlement_visible  BOOLEAN     NOT NULL DEFAULT FALSE,  -- 정산 정보 공개(기본 숨김 — 대행사 마진 보호)
  folders_visible     BOOLEAN     NOT NULL DEFAULT FALSE,  -- 자료 폴더(구매·리뷰캡쳐) 공개(기본 비노출)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ                         -- soft delete(링크도 함께 무효)
);
CREATE INDEX IF NOT EXISTS idx_tb_brands_adv ON trackb_brands(advertiser_id);

-- 작업(탭) ↔ 브랜드 배정. 같은 대행사 안에서 한 작업은 한 브랜드에만 속한다(UNIQUE).
CREATE TABLE IF NOT EXISTS trackb_brand_tab_map (
  brand_id       TEXT        NOT NULL,
  advertiser_id  TEXT        NOT NULL,
  sheet_id       TEXT        NOT NULL,
  tab_name       TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (advertiser_id, sheet_id, tab_name)
);
CREATE INDEX IF NOT EXISTS idx_tb_btm_brand ON trackb_brand_tab_map(brand_id);

COMMENT ON TABLE trackb_brands IS '대행사(광고주) 셀프서비스 브랜드 — 브랜드별 열람 링크·정산/폴더 공개 토글';
COMMENT ON TABLE trackb_brand_tab_map IS '작업(탭) → 브랜드 배정(대행사 내 1작업 1브랜드)';
