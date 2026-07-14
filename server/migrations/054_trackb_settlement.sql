-- 054: Track B 정산 파이프라인 — 탭 ↔ 인트라넷 계약(sales)/견적(quotes) 수동 링크(읽기 프록시 대상) + 광고주 노출 토글.
--   ★ 인트라넷 D1 테이블 무접촉: sales_id/quote_id 는 인트라넷 조회 키(FK 없음). 상태·금액은 HTTP 프록시로 읽기만.
--   051 링크 패턴 동일(탭당 활성 1, 소프트삭제). 되돌리기 = DROP TABLE. 부팅 재실행 idempotent.
CREATE TABLE IF NOT EXISTS trackb_settlement_links (
  id              BIGSERIAL PRIMARY KEY,
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  sales_id        TEXT,                 -- 인트라넷 sales.id (계약)
  quote_id        TEXT,                 -- 인트라넷 quotes.id (견적, 선택)
  contract_number TEXT DEFAULT '',      -- 표시 캐시(C-번호) — 프록시 실패해도 라벨 유지(fail-soft)
  linked_by       TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_settle_link_active
  ON trackb_settlement_links (sheet_id, tab_name) WHERE deleted_at IS NULL;

-- 광고주별 "정산 노출" 토글(Q4-c 안전장치). 기본 노출(행 없음=TRUE). 리뷰 PG advertisers 참조(인트라넷 아님).
CREATE TABLE IF NOT EXISTS trackb_advertiser_prefs (
  advertiser_id       TEXT PRIMARY KEY,
  settlement_visible  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by          TEXT DEFAULT '',
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
