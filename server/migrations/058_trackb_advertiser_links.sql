-- 058: Track B 광고주 전용 접속 링크(매직 링크) — 로그인 없이 링크만으로 광고주 뷰 진입.
--   업체당 1개 토큰(PK=advertiser_id, 회전 시 교체), 폐기 가능(active=FALSE).
--   토큰은 서버가 생성하는 추측불가 랜덤(base64url 24바이트). 프래그먼트(#adv=)로 전달돼 서버 로그·Referer 미유출.
--   보안: 유출 대비 즉시 폐기/회전 가능 + 광고주 뷰 자체가 마스킹·읽기전용·소유탭만(노출 최소).
--   격리: Track A/인트라넷 무접촉. advertisers 삭제 시 CASCADE. 되돌리기 = DROP TABLE. 부팅 재실행 idempotent.
CREATE TABLE IF NOT EXISTS trackb_advertiser_links (
  advertiser_id TEXT PRIMARY KEY REFERENCES advertisers(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trackb_adv_links_token ON trackb_advertiser_links(token);
