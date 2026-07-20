-- 060: Track B 통합 작업대 작업목록 즐겨찾기 — 로그인 계정별 개인화·영속(서버 원본).
--   기존 localStorage(디바이스 로컬·계정 미구분)에서 계정 귀속 저장으로 이관 →
--   ① 개인화(계정별 서로 다른 즐겨찾기) ② 언제나 유지(기기·브라우저 무관, 재접속 유지).
--   계정 1행 upsert(즐겨찾기 키 배열). 격리·비파괴. 되돌리기 = DROP TABLE. 부팅 재실행 idempotent.
CREATE TABLE IF NOT EXISTS trackb_workdesk_favorites (
  owner_key  TEXT PRIMARY KEY,                    -- 로그인 사용자 식별(req.admin.name)
  favorites  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 즐겨찾기 키 배열(sheetId␟tabName␟tabGid)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
