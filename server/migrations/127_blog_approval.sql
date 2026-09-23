-- ═══════════════════════════════════════════════════════════════════════════
-- 127 — 블로그체험단 승인제 참여 (사용자 확정 2026-08-19)
--
-- 워크플로우: 블로거가 블로그URL 만 제출(blog_pending) → 관리자가 URL 을 보고
--   [승인] → status='applied' + expires_at=NOW()+구매기한(기본 24h)
--            = **기존 홀드 파이프라인 그대로 재사용**(카운트·스윕·확정·work-detail 무수정)
--   [반려] → status='blog_rejected' + reject_reason (즉시 재신청 가능 — 유니크에서 제외)
--
-- ★ 승인 = 'applied' 전이인 이유(폭발반경 최소화): 유효홀드 판정(status='applied'
--   AND expires_at>now)을 쓰는 소비처가 십수 곳(counting·sweep·confirmHoldInTx·
--   work-detail·cancel·change-option·my-status)이라, 별도 'approved' 상태를 만들면
--   전부에 분기가 필요하고 한 곳만 놓쳐도 승인 건이 조용히 새거나 굳는다.
-- ★ 신청 대기(blog_pending)는 expires_at=NULL — TTL 없음(승인은 사람 일이라 시간이 걸린다).
--   유효홀드 카운트(status='applied')에 안 잡혀 **정원을 점유하지 않는다**(사용자 확정 ①).
-- ★ 컬럼 추가만 · 백필 0. CHECK 는 상태 어휘의 최종 방어(045 와 같은 자리)라 유지·확장.
-- ═══════════════════════════════════════════════════════════════════════════

-- ① 승인/반려 기록 컬럼 (추가만)
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS decided_at    TIMESTAMPTZ;
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS decided_by    TEXT;
ALTER TABLE campaign_applications ADD COLUMN IF NOT EXISTS reject_reason TEXT;
COMMENT ON COLUMN campaign_applications.decided_at    IS '블로그 승인/반려 시각 (127)';
COMMENT ON COLUMN campaign_applications.decided_by    IS '승인/반려한 관리자 로그인명 (127)';
COMMENT ON COLUMN campaign_applications.reject_reason IS '반려 사유 — 리뷰어 화면에 그대로 표시 (127)';

-- ② status CHECK 확장: + blog_pending / blog_rejected
--   ★ 045 의 드롭 루프(LIKE '%status%')는 chk_campaign_apps_submitted_ts 까지 지우므로
--     반드시 뒤에서 되살린다(순서 계약 — 045 와 동일).
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'campaign_applications'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE campaign_applications DROP CONSTRAINT %I', c.conname);
  END LOOP;
  BEGIN
    -- NOT VALID: 러너가 파일 다중문장을 한 암묵 트랜잭션으로 돌려 검증 스캔 중
    -- ACCESS EXCLUSIVE 가 유지된다(080/093 규율). 기존 행은 전부 구 어휘라 어차피 유효.
    ALTER TABLE campaign_applications
      ADD CONSTRAINT campaign_applications_status_check
      CHECK (status IN ('confirmed','cancelled','applied','submitted','expired',
                        'blog_pending','blog_rejected')) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER TABLE campaign_applications
      ADD CONSTRAINT chk_campaign_apps_submitted_ts
      CHECK (status <> 'submitted' OR submitted_at IS NOT NULL) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ③ 활성 홀드 부분유니크에 blog_pending 합류 — 같은 (공고, 명의)의 이중 신청 차단.
--   ★ blog_rejected 는 **일부러 제외** = 반려 즉시 재신청 가능(사용자 확정 ③).
--   113 이 submitted 를 뺀 그대로 유지(제출 차단은 /apply 서버 판정 담당).
DROP INDEX IF EXISTS uq_campaign_apps_active_hold;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_active_hold
  ON campaign_applications (campaign_id, phone8)
  WHERE status IN ('applied', 'blog_pending');
