-- 047: Track B — DB-first 참여 원장 강화(정렬무관 내용키·주문링크·seen-set) + 업체 소유 매핑.
-- ★ 가산적·비파괴·shadow: 컬럼/테이블만 추가. 기존 campaign_participants 흐름·검색·my-status·대시보드·
--   시트·주문 흐름을 일절 건드리지 않는다(라이브 무영향). Track B(마스터 전용)만 소비.
--   되돌리기 = 추가 컬럼/테이블 드롭. 모든 문장 IF NOT EXISTS(부팅 전량 재실행 idempotent).

-- ── campaign_participants 강화(추가 컬럼) ─────────────────────────────
--   identity_key: 정렬/행이동에 불변인 내용키(computeDedupKey 규칙: num:/rcp:/phone8:). 소유·상태 매칭의 안정키.
--   order_submission_id: 주문원장(order_submissions.id) 링크 — 있으면 불변 UUID가 최종 신원 앵커.
--   active/absent_since: seen-set 재투영(이번 빌드에 보였나). 삭제·비우기·행재사용을 자동 반영(하드삭제 아님).
--   first_seen_at/price: 감사·금전 정합용.
ALTER TABLE campaign_participants
  ADD COLUMN IF NOT EXISTS identity_key        TEXT,
  ADD COLUMN IF NOT EXISTS order_submission_id UUID,
  ADD COLUMN IF NOT EXISTS active              BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS absent_since         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_seen_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS price                TEXT;

-- 내용키 매칭·집계 가속(활성 행 한정). 유니크 아님 — seq 유니크가 임포트 멱등을 이미 보장하고,
--   같은 탭에 동일 내용키가 (드물게) 복수 물리행으로 존재할 수 있어 유니크로 막지 않는다(관측 대상).
CREATE INDEX IF NOT EXISTS idx_participants_identkey
  ON campaign_participants (sheet_id, tab_gid, identity_key) WHERE identity_key IS NOT NULL AND active;
CREATE INDEX IF NOT EXISTS idx_participants_order
  ON campaign_participants (order_submission_id) WHERE order_submission_id IS NOT NULL;

-- ── 업체(광고주) ↔ 캠페인(시트/탭) 소유 매핑 ──────────────────────────
--   단순 1:N(한 업체가 다수 시트/탭 소유) 우선. tab_gid NULL = 그 시트의 모든 탭 소유(시트 단위).
--   세밀 분해조립(한 시트에 여러 업체 혼재)은 후속 — 지금은 시트/탭 단위로 충분.
--   advertiser_id 는 advertisers.id(026_portal) 참조(FK 미설정 — 부팅 전량 재실행/삭제순서 안전 위해 느슨).
CREATE TABLE IF NOT EXISTS advertiser_campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id UUID NOT NULL,
  sheet_id      TEXT NOT NULL,
  tab_gid       TEXT,                       -- NULL = 시트 전체(모든 탭)
  assigned_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
-- 같은 (업체, 시트, 탭) 중복 방지. tab_gid NULL 은 COALESCE 로 공문자열 취급해 시트단위 1행 보장.
CREATE UNIQUE INDEX IF NOT EXISTS uq_adv_camp
  ON advertiser_campaigns (advertiser_id, sheet_id, COALESCE(tab_gid, ''));
CREATE INDEX IF NOT EXISTS idx_adv_camp_sheet
  ON advertiser_campaigns (sheet_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_adv_camp_adv
  ON advertiser_campaigns (advertiser_id) WHERE deleted_at IS NULL;
