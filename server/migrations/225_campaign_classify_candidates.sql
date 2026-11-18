-- 225: 공고별 「분류 후보」 — 사용자 확정 2026-11-18 (결정 383).
--
-- 옵션 없는(또는 옵션 1개) 「택1」 공고(예: 피치/레몬/스트로베리 중 자율 1개)에서, 직원이 공고 창에 후보를 적어 두면
-- 리뷰어가 구매양식을 낼 때 이미 읽은 구매캡처 옵션 글자로 후보 하나가 확실할 때만 작업보드 「분류」 칸(추가 열)에 적는다.
--   recruit_campaigns.classify_candidates  ''=사용 안 함(기존 동작 그대로) · 그 외=후보 글(`피치, 레몬, 스트로베리`)
-- ★ 정원·참여·옵션·인트라넷 리뷰오더와 무관한 리뷰웹 전용 칸이다(공유 칸 아님).
-- ★ 가산 전용 · 러너가 매 기동 시 전 파일을 재실행하므로 멱등이어야 한다. 옛 공고는 '' (= 무변화).
-- 롤백: DROP COLUMN(코드가 먼저 되돌아가 있어야 한다). 이미 적힌 「분류」 값은 작업보드 추가 열(trackb_custom_column_values)에 남는다.

ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS classify_candidates TEXT NOT NULL DEFAULT '';
