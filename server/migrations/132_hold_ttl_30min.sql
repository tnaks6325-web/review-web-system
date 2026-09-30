-- 132: 참여 자리 유효시간(홀드 TTL) 기본값 15분 → 30분 (사용자 확정 2026-08-20)
--
-- 왜: 리뷰어가 [참여하기]를 누른 뒤 **구매 + 구매양식 제출까지** 끝내야 하는 시간이 15분이라
--   결제·배송지 입력이 늦어지면 자리가 만료되고, 이미 결제한 건은 지각(late_order_id)이 되어
--   관제 수동확정으로만 구제됐다. 그 시간을 30분으로 늘린다.
--
-- ★ 컬럼 DEFAULT 변경(신규 공고) + **기본값 그대로였던 기존 공고만** 백필.
--   관리자가 공고별로 다른 값(예 20분·60분)을 명시 저장해 둔 공고는 건드리지 않는다
--   — 사람이 정한 값을 일괄 변경이 덮으면 안 된다. NULL(미설정)도 이 기회에 30으로 확정.
-- ★ 타계정 건 TTL(`sub_hold_ttl_min`, 기본 10분)은 이번 변경 대상이 아니다(별도 정책).
ALTER TABLE recruit_campaigns
  ALTER COLUMN hold_ttl_min SET DEFAULT 30;

UPDATE recruit_campaigns
   SET hold_ttl_min = 30
 WHERE hold_ttl_min IS NULL OR hold_ttl_min = 15;
