-- 089: 리뷰웹시스템[3버전] "열린 작업 줄"(개인별) + "오늘 완료"(전사 공통) — 시트 탭 워크플로우 이관 M2.
--   설계 = PRD frontend/docs/prd-workboard-worktabs.html (v1.2, 사용자 확정). M1(088 마감)의 후속.
--
-- ★★ "오늘 완료"와 "마감"은 다른 것이다(사용자 확정):
--    ㉮ 오늘 완료 = 그 작업의 **오늘 할 일**을 끝냄 → 줄 뒤로 + 회색, **다음날 자동 해제**, 매일 반복.
--    ㉯ 마감(088) = **작업 자체의 종료** → 보드에서 빠져 보관함으로, 영구.
--    구분하지 않으면 "오늘 몫 끝낸 작업"이 모두의 보드에서 사라지거나, 끝난 작업이 매일 아침 되살아난다.
--
-- 되돌리기 = 라우트 미마운트 + DROP TABLE 2개. 부팅 재실행 idempotent.

-- ① 열린 작업 줄 — **개인별**(계정 귀속). 브라우저 탭처럼 열어둔 작업 목록 + 그 순서.
--   ★★ 즐겨찾기 원장(trackb_workdesk_favorites)에 접두를 붙여 얹지 않는다: 그쪽은 클라이언트가 Set 으로
--     재직렬화해 **순서가 보존되지 않는다**. 여기서 순서는 곧 사용자가 드래그로 정한 탭 배치다.
--   구조는 즐겨찾기와 같은 형태(계정당 1행 upsert) — 검증된 관용구를 그대로 따른다.
CREATE TABLE IF NOT EXISTS trackb_workdesk_worktabs (
  owner_key  TEXT PRIMARY KEY,                  -- 로그인 사용자 식별(req.admin.name)
  tabs       JSONB NOT NULL DEFAULT '[]'::jsonb, -- 순서 있는 키 배열(sheetId␟tabName␟tabGid)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ② 오늘 완료 — **전사 공통**(담당자가 끝내면 팀 전체에 반영, 홈 "오늘 완료 n/m" = 팀 진행률).
--   ★★ 판정 = "done_date 가 KST 오늘과 같은 행이 있는가" → **자정 리셋 크론이 필요 없다**
--     (날짜가 바뀌면 어제 행은 저절로 조건에서 빠진다 = 해제 조작·배치 0).
--   ★ 날짜별 이력이 그대로 남아 "언제 처리했나" 추적이 된다(해제는 오늘 행만 DELETE).
CREATE TABLE IF NOT EXISTS trackb_tab_daily_done (
  id         BIGSERIAL PRIMARY KEY,
  sheet_id   TEXT NOT NULL,
  tab_name   TEXT NOT NULL,
  done_date  DATE NOT NULL,                     -- KST 기준 날짜(서버가 파생 — 클라이언트 시계 불신)
  done_by    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 같은 탭·같은 날 중복 불가(멱등 upsert 의 충돌 대상)
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackb_daily_done
  ON trackb_tab_daily_done (sheet_id, tab_name, done_date);

-- 오늘분 조회(작업보드·홈이 매 렌더마다 본다)
CREATE INDEX IF NOT EXISTS idx_trackb_daily_done_date
  ON trackb_tab_daily_done (done_date);
