-- 028_error_debug.sql
-- 오류디버깅(Error Debugging) 확장 — error_logs 에 상태머신/오류검증/다중에이전트 분석 컬럼 추가
-- 프로토콜: 수집 → 오류검증 → 레드팀/블루팀/감독관/예방가드/결정자 → 이행요청 → 실제수정 → 재검증
-- (참고: 리뷰웹시스템 오류 디버깅 및 오류수정 프로토콜 문서)
-- ※ 자동 마이그레이션 러너(index.js)는 idempotent 재실행을 전제 → IF NOT EXISTS / 예외무시 사용.

-- 1) 상태머신: new | investigating | resolved | ignored ----------------------------
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
-- 기존 resolved 불리언 → status 백필 (최초 1회만 의미 있음)
UPDATE error_logs SET status = 'resolved' WHERE resolved = TRUE AND status = 'new';
-- CHECK 제약 (이미 있으면 무시)
DO $$ BEGIN
  ALTER TABLE error_logs ADD CONSTRAINT error_logs_status_chk
    CHECK (status IN ('new','investigating','resolved','ignored'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) 오류검증 판정값 (8장): not_checked|likely_reproducible|reproduced|
--    not_reproduced_static|likely_resolved_by_other_change|blocked
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS verify_verdict TEXT NOT NULL DEFAULT 'not_checked';

-- 3) 결정자 판정값 (9.6장): implement|implement_after_preflight|needs_more_context|ignore
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS decider_verdict TEXT NOT NULL DEFAULT '';

-- 4) 다중 에이전트 분석 결과(JSONB)
--    { verify, red_team, blue_team, supervisor, prevention_guard, decider,
--      preflight[], go_no_go, fix_scope, test_plan, must_verify[], residual_risk,
--      summary_ko, generated_by, generated_at }
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS analysis JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS analyzed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS status_updated_by TEXT NOT NULL DEFAULT '';

-- 5) dedup 활성행 유니크 인덱스 재정의 -------------------------------------------
--    기존: WHERE resolved = FALSE   →   신규: WHERE status <> 'resolved'
--    new/investigating/ignored 는 fingerprint 당 1행으로 롤업(occurrence_count 증가),
--    resolved 과거행은 별도 보존 → 같은 signature 가 다시 들어오면 신규 'new' 행 생성(=재오픈).
--    ※ 백필 결과 status='new' 행 집합 == 기존 resolved=FALSE 행 집합 → 유니크 충돌 없음(안전).
--    ※★ FORWARD-ONLY: 이 마이그레이션은 구버전 인덱스 uq_error_logs_fp_open 을 영구 삭제한다.
--       028 적용 이후에는 구버전 서버 빌드를 재배포하지 말 것. 구버전 logAbnormal 의
--       UPSERT 는 `ON CONFLICT ... WHERE resolved = FALSE` 를 사용하는데, 그 인덱스가 없으면
--       매 적재마다 "no unique or exclusion constraint matching ON CONFLICT" 에러로 dedup 이
--       조용히 깨진다(로깅 try/catch 로 흡수되어 표면화되지 않음).
DROP INDEX IF EXISTS uq_error_logs_fp_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_error_logs_fp_active
  ON error_logs(fingerprint) WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_error_logs_status ON error_logs(status);
