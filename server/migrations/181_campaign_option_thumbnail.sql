-- 181: 선택지(상품)별 사진 — 순차진행 공고에서 지금 모집 중인 상품의 사진을 공고 대표 사진 대신 보여준다(결정 214).
--   빈 값 = 공고 대표 사진을 그대로 쓴다(종전 동작). 리뷰웹 관리자가 공고 설정 화면에서 입력한다.
ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS thumbnail_url TEXT NOT NULL DEFAULT '';
