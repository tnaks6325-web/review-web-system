-- 059: 리뷰어 앱 공고수정 허용 명단 (마스터가 UI로 관리)
--   리뷰어 로그인(이름+전화 뒤8자리)은 관리자 로그인보다 약하므로, "리뷰어 화면에서
--   공고를 수정할 수 있는 사람"을 마스터가 phone8로 명시 허용한 사람만으로 제한한다.
--   토큰 발급 조건 = (verifyReviewer로 이름+phone8 실 리뷰어 확인) AND (이 표에 active).
--   발급 토큰은 via:'reviewer_campaign'·role:'admin'·2h·/api/campaign PUT 전용(authMiddleware 격리).
--   되돌리기 = DROP TABLE. Track A 핫패스·시트·인트라넷 무접촉. 부팅 재실행 idempotent.
CREATE TABLE IF NOT EXISTS reviewer_campaign_editors (
  phone8      TEXT PRIMARY KEY,                    -- 리뷰어 로그인 번호 뒤 8자리(허용 키)
  label       TEXT NOT NULL DEFAULT '',            -- 표시용 이름/메모(예: 김수만·박세희)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  added_by    TEXT DEFAULT '',                     -- 등록한 마스터 로그인명(감사)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
