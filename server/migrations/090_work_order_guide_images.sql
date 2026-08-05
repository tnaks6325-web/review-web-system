-- 090: 작업오더 첨부 이미지 구조화 (칸=칸 매핑 2단계 — docs/prd-order-field-mapping.html)
--
-- 배경: 유입가이드 첨부 이미지가 inflow_guide/review_guide 텍스트 안에
--   "[유입가이드 첨부 이미지]\n1. 파일명 (29KB, Drive 저장됨)\nURL" 블록으로 실려 와,
--   리뷰웹이 텍스트에서 URL 을 추출("승격")해야 이미지를 보여줄 수 있었다.
--   이제 인트라넷이 URL 배열을 guide_images 로 함께 보내고, 리뷰웹은 파싱 없이 그대로 쓴다.
--
-- ★ TEXT 에 JSON 배열 문자열 저장(product_options_json 과 같은 규율) — FK 없음 · CHECK 없음.
-- ★ 컬럼 추가만 · 백필 0 — 빈 값(과거 오더·구버전 인트라넷)은 종전 텍스트 블록 승격 경로 그대로(가산적).
-- ★ 저장 전 서버가 정규화(_guideImagesJson: http(s) URL 만 · 최대 8장)하므로 자유 문자열이 못 들어온다.

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS guide_images TEXT DEFAULT '';
