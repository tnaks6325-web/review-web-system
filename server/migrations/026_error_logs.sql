-- 026_error_logs.sql
-- 이상 이벤트(에러/이상징후) 구조화 로그 — 근본원인 분석 + 자연어(한국어) 설명
-- 비정상 로그만 영구 저장하여, "어떤 기능 / 어떤 단계 / 어떤 종류 / 어디서" 를
-- 한 문장의 한국어(message_ko)로 풀이해 관리자가 근본원인을 바로 인지하게 함.
-- ※ migrate.js / index.js 러너는 idempotent 재실행을 전제로 하므로 IF NOT EXISTS 사용.

CREATE TABLE IF NOT EXISTS error_logs (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity         TEXT NOT NULL DEFAULT 'error'      -- warn | error | critical
                   CHECK (severity IN ('warn','error','critical')),
  flow             TEXT NOT NULL DEFAULT 'unknown',   -- 기능/플로우 키 (예: order_submit)
  flow_ko          TEXT NOT NULL DEFAULT '',          -- 플로우 한글 라벨 (예: 구매양식제출)
  step             TEXT NOT NULL DEFAULT '',          -- 단계 키 (예: image_upload)
  step_ko          TEXT NOT NULL DEFAULT '',          -- 단계 한글 라벨 (예: 이미지 업로드)
  category         TEXT NOT NULL DEFAULT 'unknown'    -- 에러 종류
                   CHECK (category IN ('timeout','quota','auth','permission','network','validation','db','external_api','not_found','unknown')),
  source           TEXT NOT NULL DEFAULT 'server'     -- 발생 위치
                   CHECK (source IN ('server','external_api','db','client')),
  message_ko       TEXT NOT NULL DEFAULT '',          -- ★ 합성된 자연어(한국어) 설명 문장
  message_raw      TEXT NOT NULL DEFAULT '',          -- 원본 error.message
  error_code       TEXT NOT NULL DEFAULT '',          -- error.code/name/status (ETIMEDOUT, 429 등)
  stack            TEXT NOT NULL DEFAULT '',          -- 스택트레이스 (앞부분만)
  context          JSONB NOT NULL DEFAULT '{}'::jsonb,-- {path,method,ip,userAgent,requestId,userId,extra...}
  fingerprint      TEXT NOT NULL DEFAULT '',          -- 중복 그룹핑 키 (flow|step|category|source|정규화메시지)
  occurrence_count INTEGER NOT NULL DEFAULT 1,        -- 같은 fingerprint 누적 발생 횟수
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved         BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT NOT NULL DEFAULT '',
  resolve_note     TEXT NOT NULL DEFAULT ''
);

-- dedup UPSERT 대상: 미해결 동일 fingerprint 는 1행으로 롤업(occurrence_count 증가).
-- 부분 유니크 인덱스 — 해결(resolved=TRUE)된 과거 행과 새 재발 행이 공존 가능.
CREATE UNIQUE INDEX IF NOT EXISTS uq_error_logs_fp_open
  ON error_logs(fingerprint) WHERE resolved = FALSE;

CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_last_seen  ON error_logs(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_category   ON error_logs(category);
CREATE INDEX IF NOT EXISTS idx_error_logs_flow       ON error_logs(flow);
CREATE INDEX IF NOT EXISTS idx_error_logs_resolved   ON error_logs(resolved);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity   ON error_logs(severity);
