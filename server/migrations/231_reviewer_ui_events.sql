-- 231: 리뷰어 화면 사건 횟수 (결정 427 · 2026-11-25)
--   구매양식을 새로고침해 넣은 사진이 지워졌을 때 「…을 다시 넣어 주세요」 안내가 몇 번 떴는지만 센다
--   (사진을 휴대폰·서버에 보관해 되살릴지(A·B안) 2주 뒤 판단 근거 — 4단계 조사 2026-11-25 정해야 할 것 5).
-- ★★ 개인정보를 담지 않는다(완화 금지) — 이름·전화·사진·주문번호·리뷰어 id·인터넷 주소 칸이 없다. 사건 이름·화면·사진 칸 수·시각뿐.
-- ★ 추가만 하는 기록 표 — 다른 표를 바꾸지 않는다. 작업(sheet_id·tab_name)·업체에 묶이지 않아 작업 삭제·업체 합치기 분류 대상 아님.
-- ★ 없어도 서버는 뜬다(REQUIRED_TABLES 에 넣지 않음 — 기록 실패는 삼킨다). 되돌리기 = 라우트 제거 + DROP TABLE reviewer_ui_events.
CREATE TABLE IF NOT EXISTS reviewer_ui_events (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT NOT NULL,                 -- 허용 목록만(photo_reattach_notice)
  screen     TEXT NOT NULL DEFAULT '',      -- campaign(공고 화면 안 구매양식) · direct(구매양식 직접 링크)
  slots      INT  NOT NULL DEFAULT 0,       -- 다시 넣어 달라고 한 사진 칸 수(1~20)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviewer_ui_events_created ON reviewer_ui_events (created_at DESC);
