-- 180: 상품 옵션의 한도·상태가 바뀌거나 옵션을 지우면 공고의 "인원 규칙 변경" 시각을 남긴다
--      (어제 모집 부족 인원 팝업 — 결정 202)
-- ★ 마지막 한도 옵션을 지우면(행이 사라짐) 옵션 표만 봐서는 어제 한도가 있었는지 알 수 없다 → 공고 쪽에 기록을 남긴다(코덱스 리뷰).
-- ★ 결제금액 동기화(pay_amount)는 대상이 아니다 — 그 경로는 공고 행을 잠그지 않아, 여기서 공고 행을 건드리면
--   옵션 저장(공고 행 → 옵션 순서로 잠금)과 잠금 순서가 뒤집혀 교착될 수 있다. 한도·상태·이름·삭제·추가만 본다.
CREATE OR REPLACE FUNCTION trg_campaign_options_rules_changed() RETURNS trigger AS $fn$
BEGIN
  UPDATE recruit_campaigns SET quota_rules_changed_at = NOW()
   WHERE id = COALESCE(NEW.campaign_id, OLD.campaign_id);
  RETURN NULL;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_options_rules_changed_upd ON campaign_options;
CREATE TRIGGER campaign_options_rules_changed_upd
  AFTER UPDATE OF status, daily_limit, recruit_total, opt_key ON campaign_options
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.daily_limit IS DISTINCT FROM NEW.daily_limit
     OR OLD.recruit_total IS DISTINCT FROM NEW.recruit_total OR OLD.opt_key IS DISTINCT FROM NEW.opt_key)
  EXECUTE FUNCTION trg_campaign_options_rules_changed();

DROP TRIGGER IF EXISTS campaign_options_rules_changed_ins_del ON campaign_options;
CREATE TRIGGER campaign_options_rules_changed_ins_del
  AFTER INSERT OR DELETE ON campaign_options
  FOR EACH ROW EXECUTE FUNCTION trg_campaign_options_rules_changed();
