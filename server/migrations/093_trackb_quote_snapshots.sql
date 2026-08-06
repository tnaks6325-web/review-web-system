-- 093: 견적서 버전 스냅샷 — "초안도 계속 열람" 보존 원장
--   인트라넷 quotes 는 수정 시 제자리 덮어쓰기(버전 개념 없음)라, 광고주 견적서 뷰어의
--   "초안→최종 모두 열람" 요구를 리뷰웹 쪽 스냅샷으로 충족한다(인트라넷 무변경).
--   저장 시점 = 견적 상세 프록시 조회 시, 내용 해시(content_hash)가 최신 버전과 다르면
--   새 버전으로 append-only 적재. 해시에는 상태(status)도 포함 — 내용이 같아도
--   draft→accepted 전이가 새 버전이 되어 "초안/최종" 자동 라벨의 근거가 된다.
--   ★ 한계(설계 합의): 이력은 이 기능 배포 후 첫 조회 시점부터 쌓인다 — 과거에 이미
--     덮어써진 초안은 복원 불가.

CREATE TABLE IF NOT EXISTS trackb_quote_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  sales_id      TEXT        NOT NULL,               -- 인트라넷 sales.id (정산 링크와 같은 키)
  version       INTEGER     NOT NULL,               -- 1부터 증가(sales_id별)
  content_hash  TEXT        NOT NULL,               -- 문서 내용+상태 해시(중복 적재 방지)
  payload       JSONB       NOT NULL,               -- 견적 상세 전문(품목·금액·수신자·상태…)
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sales_id, version)
);
CREATE INDEX IF NOT EXISTS idx_tqs_sales ON trackb_quote_snapshots(sales_id);

COMMENT ON TABLE trackb_quote_snapshots IS
  '인트라넷 견적서 내용 버전 스냅샷(append-only) — 광고주 견적서 뷰어의 초안/최종 이력 원천';
