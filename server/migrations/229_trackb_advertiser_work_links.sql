-- 229: 업체 작업 링크의 단축 주소 (결정 419 · 2026-11-25 직원 신고)
--   작업보드 [🏢 광고주링크]가 복사하던 `#a=<열쇠>&work=<작업 좌표>` 는 작업 이름(한글·괄호)이 들어가 200자를 넘었고,
--   카카오톡이 주소 속 `)` 에서 링크를 끊었다. → `/workdesk#k=<code>` 짧은 주소를 주고, 받은 화면이 원래 주소로 되돌린다.
--
-- ★★ 코드는 권한을 새로 만들지 않는다(완화 금지) — 그때의 접속 열쇠(token) + 작업 좌표만 가리키고,
--    입장은 기존 교환(loginByLinkToken)이 판정한다. 폐기하면 막히고, 회전하면 옛 열쇠를 가리키는 코드는 죽는다.
-- ★ 같은 (열쇠, 작업)이면 코드 하나(유일 색인) — 이미 보낸 주소가 다음 복사로 바뀌지 않는다.
-- ★ 작업을 지우면 함께 지운다(workTabDelete DELETE_TABLES). 격리: 신규 표만. 되돌리기 = 라우트 제거 + DROP TABLE.
CREATE TABLE IF NOT EXISTS trackb_advertiser_work_links (
  code          TEXT PRIMARY KEY,                  -- 추측불가 랜덤(base64url 9바이트 = 12자)
  token         TEXT NOT NULL,                     -- 만들 때의 업체 접속 열쇠(trackb_advertiser_links.token)
  sheet_id      TEXT NOT NULL,
  tab_name      TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_adv_work_links
  ON trackb_advertiser_work_links(token, sheet_id, tab_name);
CREATE INDEX IF NOT EXISTS idx_trackb_adv_work_links_tab
  ON trackb_advertiser_work_links(sheet_id, tab_name);
