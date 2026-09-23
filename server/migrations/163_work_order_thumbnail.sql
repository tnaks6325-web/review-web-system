-- 163: 작업오더 썸네일 (사용자 확정 2026-09-21)
--
-- ★ 왜 필요한가: 모집공고 썸네일(045 `recruit_campaigns.thumbnail_url`)을 인트라넷 리뷰오더에서도
--   정할 수 있게 한다. 지금은 공고를 만든 뒤 리뷰웹 화면에서만 올릴 수 있어, 오더를 낸 사람이
--   자기 상품 사진을 넣을 창구가 없었다.
--
-- ★★ **컬럼 추가만 · 백필 0 · CHECK 0 · FK 0** = 배포 즉시 동작 불변(opt-in).
--    값이 비면 종전 그대로 리뷰웹에서 올린 썸네일이 쓰인다.
-- ★ TEXT — `recruit_campaigns.thumbnail_url` 과 같은 타입(082 의 42804 규율).
-- ★ 값은 **우리 프록시 절대 URL** 만 저장한다(`_thumbnailUrl` 이 검증) — Drive 원본이나 임의 주소를
--   그대로 두면 리뷰어 화면 <img> 가 교차 오리진에서 깨지거나 남의 주소가 실린다.

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT DEFAULT '';
