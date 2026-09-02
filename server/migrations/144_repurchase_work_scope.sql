-- 144: 동일 작업 전체 재참여 제한의 기준 키를 주문 원장에 보존한다.
--
-- 날짜별 탭 설정(tab_configs)은 과거 빈 껍데기 정리로 삭제될 수 있다. 제한 판정이 그 현재
-- 설정 행만 조인하면, 18일 주문 이력의 작업명을 더는 알 수 없어 19일/20일 재참여가 풀린다.
-- 주문이 확정될 당시의 "시트 + 정규화 작업명"을 order_submissions에 기록해 그 정리와 독립시킨다.

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS repurchase_work_key TEXT;

-- 아직 설정 행이 남은 과거 주문은 가장 직접적인 원본(tab_configs)으로 1회 보정한다.
UPDATE order_submissions os
   SET repurchase_work_key = os.sheet_id || E'\x1f' || BTRIM(tc.campaign_name)
  FROM tab_configs tc
 WHERE os.repurchase_work_key IS NULL
   AND tc.sheet_id = os.sheet_id
   AND tc.tab_name = os.tab_name
   AND NULLIF(BTRIM(tc.campaign_name), '') IS NOT NULL;

-- 이미 탭 설정이 정리된 과거 주문은 불변 주문 UUID로 연결된 작업표 기록이 있을 때만 보정한다.
-- 이름/전화번호 같은 추정 매칭은 하지 않는다.
WITH participant_work AS (
  SELECT DISTINCT ON (cp.order_submission_id)
         cp.order_submission_id,
         cp.sheet_id || E'\x1f' || BTRIM(cp.campaign_name) AS work_key
    FROM campaign_participants cp
   WHERE cp.order_submission_id IS NOT NULL
     AND NULLIF(BTRIM(cp.campaign_name), '') IS NOT NULL
   ORDER BY cp.order_submission_id, cp.updated_at DESC, cp.id DESC
)
UPDATE order_submissions os
   SET repurchase_work_key = pw.work_key
  FROM participant_work pw
 WHERE os.repurchase_work_key IS NULL
   AND os.id = pw.order_submission_id
   AND split_part(pw.work_key, E'\x1f', 1) = os.sheet_id;

-- 모든 주문 기록 경로(셀프 참여·외부모집·진단 수동등록)가 자동으로 같은 키를 남긴다.
CREATE OR REPLACE FUNCTION set_order_submission_repurchase_work_key()
RETURNS trigger AS $$
DECLARE v_work_name TEXT;
BEGIN
  IF NULLIF(BTRIM(NEW.repurchase_work_key), '') IS NULL THEN
    SELECT NULLIF(BTRIM(campaign_name), '')
      INTO v_work_name
      FROM tab_configs
     WHERE sheet_id = NEW.sheet_id AND tab_name = NEW.tab_name
     LIMIT 1;
    IF v_work_name IS NOT NULL THEN
      NEW.repurchase_work_key := NEW.sheet_id || E'\x1f' || v_work_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_submission_repurchase_work_key ON order_submissions;
CREATE TRIGGER trg_order_submission_repurchase_work_key
BEFORE INSERT ON order_submissions
FOR EACH ROW EXECUTE FUNCTION set_order_submission_repurchase_work_key();

CREATE INDEX IF NOT EXISTS idx_order_submissions_repurchase_work_key
  ON order_submissions (
    repurchase_work_key,
    (RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 8)),
    submitted_at DESC
  )
  WHERE deleted_at IS NULL
    AND repurchase_work_key IS NOT NULL;
