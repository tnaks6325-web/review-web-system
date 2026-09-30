-- 169: 합쳐진 업체·브랜드의 옛 접속 링크를 계속 열리게 하는 별칭(2026-09-28 올곧은무역·어니스트캄 병합).
--
-- 왜: 업체 접속 링크는 업체당 1개(trackb_advertiser_links PK=advertiser_id)이고 브랜드 링크는 브랜드 행에
--     1개다. 같은 업체가 둘로 갈려 있다가 합치면 **양쪽 링크를 업체(브랜드사)가 이미 쓰고 있을 수 있다**
--     (실측: 어니스트캄 옛 링크 9/21 · 새 링크 9/28 접속). 옛 주소를 죽이면 업체가 막힌다.
--
-- ★★ 별칭은 권한을 새로 만들지 않는다 — 로그인 시 **대상(합쳐진 업체·브랜드)의 현재 링크 상태**를
--    그대로 따른다: 대상 링크가 폐기(active=FALSE)면 별칭도 열리지 않고, 대상 링크를 [회전]하면
--    별칭을 함께 지운다(유출 대응이 약해지지 않게). 쓰기 표면 = 이 표 하나. 되돌리기 = DROP TABLE.
CREATE TABLE IF NOT EXISTS trackb_link_aliases (
  token        TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('advertiser', 'brand')),
  target_id    TEXT NOT NULL,          -- kind=advertiser → advertisers.id / kind=brand → trackb_brands.id
  merged_from  TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trackb_link_aliases_target ON trackb_link_aliases (kind, target_id);
