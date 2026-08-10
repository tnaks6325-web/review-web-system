-- 101: 옵션별 유입링크 + 공고 유입방식
--
-- 배경(사용자 요구 2026-08-10): 링크유입 작업에서 옵션이 여러 개여도 리뷰어가 여는 주소는
--   `recruit_campaigns.landing_url` **한 칸**뿐이라, 화이트를 고른 리뷰어도 베이지를 고른 리뷰어도
--   같은 상품 페이지로 들어간다(다른 상품 구매 · 유입 성과 훼손). 어느 층에도 옵션별 링크를
--   담을 자리가 없었다 — 인트라넷 옵션 행 · product_options_json · 리뷰웹 진행상품 표 · campaign_options.
--
-- PRD = frontend/docs/prd-option-landing-url.html (v1.0 확정 · D1~D6 + 보충 2건)
--
-- ★ 087(리뷰타입) · 099(work_kind) 규율 그대로:
--     · 컬럼 추가만 · **백필 0** · **DB CHECK 없음**(판정을 코드와 DB 에 이중화하면 어휘가 늘 때
--       저장이 실패한다 — 판정 단일 출처는 utils/optionLanding.js · utils/inflowType.js)
--     · TEXT (082 의 42804 FK 타입 사고 계열 회피 — 새 FK 도입 안 함.
--       campaign_options 는 이미 campaign_id TEXT REFERENCES recruit_campaigns(id) 를 갖고 있다)
--
-- ★★ **빈 값 = 지금 동작 100% 불변**(옵트인):
--     · campaign_options.landing_url = '' → 리뷰어는 종전처럼 공고 랜딩 URL로 들어간다(폴백).
--     · recruit_campaigns.inflow_type = '' → 종전처럼 연결 작업오더를 역조회해 유입방식을 판정한다
--       (_lookupInflowType). "한 번도 정하지 않음"과 "가이드로 정함"을 구분할 수 있어야
--       CASE 센티널 편집(null=유지 / ''=해제)이 성립하므로 백필하지 않는다.
--
-- 되돌리기: 두 컬럼 DROP + 킬스위치 CAMPAIGN_OPTION_LANDING=0 (읽는 쪽이 전부 폴백이라 즉시 종전 동작).

ALTER TABLE campaign_options   ADD COLUMN IF NOT EXISTS landing_url TEXT DEFAULT '';
ALTER TABLE recruit_campaigns  ADD COLUMN IF NOT EXISTS inflow_type TEXT DEFAULT '';

COMMENT ON COLUMN campaign_options.landing_url  IS '옵션별 유입 링크(https 만). 빈 값 = 공고 landing_url 폴백 — 판정 단일 출처 utils/optionLanding.js';
COMMENT ON COLUMN recruit_campaigns.inflow_type IS '유입방식: ''''(미지정,기본) | link | guide — 미지정이면 작업오더 역조회. 판정 단일 출처 utils/inflowType.js';
