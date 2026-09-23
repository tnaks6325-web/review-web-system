-- ═══════════════════════════════════════════════════════════
-- 139: 모집 이월 배치 전략(carry_strategy)
--
-- carry_mode(auto|hold)는 "자동 이월을 보류할지"의 기존 기능이다.
-- 배치 방식(next|spread|extend)을 여기에 섞으면 보류 카드·수동 반영의 의미가
-- 바뀌므로 별도 컬럼으로 둔다. 기존 공고의 NULL은 서버에서 next로 해석해
-- 현재 운영 중인 다음날 자동 가산을 바꾸지 않는다.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS carry_strategy TEXT DEFAULT 'next';
