-- 133: 타계정 명의 참여 자리 유효시간(sub_hold_ttl_min) 기본값 10분 → 15분 (사용자 확정 2026-08-20)
--
-- 왜: 132 에서 본계정 홀드 TTL 을 30분으로 늘렸고, 같은 이유(구매 + 구매양식 제출까지의 시간)로
--   타계정 명의 건도 10분은 짧다. 15분으로 늘린다(본계정 30분보다는 여전히 짧게 유지 —
--   타계정은 소유자 합산 동시홀드 상한이 걸린 자리라 오래 잡고 있으면 남의 자리를 막는다).
--
-- ★ 컬럼 DEFAULT 변경(신규 공고) + **기본값 그대로였던 기존 공고만** 백필.
--   관리자가 공고별로 명시 지정한 값은 건드리지 않는다(132 와 같은 규율). NULL 도 15로 확정.
-- ★ 0 은 저장 경로가 이미 1 이상으로 클램프하므로 여기서는 나타나지 않는다.
ALTER TABLE recruit_campaigns
  ALTER COLUMN sub_hold_ttl_min SET DEFAULT 15;

UPDATE recruit_campaigns
   SET sub_hold_ttl_min = 15
 WHERE sub_hold_ttl_min IS NULL OR sub_hold_ttl_min = 10;
