-- 131: 작업보드/업체 공유 링크 — 메신저(카카오톡)로 "그 작업보드 주소"를 바로 전달하기 위한 짧은 고유 주소.
--   배경: 인수인계(택배·문의) 때 상대가 검색 탭에서 매번 찾아 들어가야 했다. 이제 작업보드 상단 [🔗 링크]
--   한 번이면 `.../workdesk#w=<code>` 가 복사되고, 받은 사람은 열자마자 그 작업보드로 직행한다.
--
-- ★★ 링크는 권한이 아니다(완화 금지) — code 는 "어디로 갈지"만 말하고, 실제 열람은 평소와 똑같이
--    로그인 + 서버 스코프 검증(canAccessTab)을 통과해야 한다. 링크가 유출돼도 권한이 넓어지지 않는다.
-- ★ 대상마다 코드 1개(부분 유니크) = 언제 눌러도 같은 주소가 나온다(공유해 둔 링크가 살아 있다).
-- ★ 격리: 신규 테이블만. Track A·인트라넷·시트 무접촉. 되돌리기 = 라우트 제거 + DROP TABLE.
CREATE TABLE IF NOT EXISTS trackb_share_links (
  code          TEXT PRIMARY KEY,                  -- 추측불가 랜덤(base64url 9바이트) — 주소 꼬리
  kind          TEXT NOT NULL CHECK (kind IN ('tab','advertiser')),
  sheet_id      TEXT NOT NULL DEFAULT '',          -- kind='tab'
  tab_name      TEXT NOT NULL DEFAULT '',          -- kind='tab'
  tab_gid       TEXT NOT NULL DEFAULT '',          -- 표시/재매칭 보조(blank-only 보정)
  advertiser_id TEXT REFERENCES advertisers(id) ON DELETE CASCADE,   -- kind='advertiser'
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_share_tab
  ON trackb_share_links(sheet_id, tab_name) WHERE kind = 'tab';
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_share_adv
  ON trackb_share_links(advertiser_id) WHERE kind = 'advertiser';
