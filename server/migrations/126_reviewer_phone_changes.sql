-- 126: 리뷰어 로그인 번호 변경 이력 (등록리뷰어DB 관리자 기능)
--
-- 배경: `reviewers.phone` 을 바꾸면 파생 컬럼 `phone8`(GENERATED)이 통째로 바뀌는데,
--   이 시스템의 참여·주문·문의·정산은 전부 phone8 을 신원키로 쓴다. 그래서 번호 변경은
--   "칸 하나 수정"이 아니라 **신원키 교체**이고, 지금까지 그 조작을 남길 곳이 없었다
--   (계좌 변경만 121/123/125 감사 트리거 보유).
--
-- ★ 컬럼 추가·신규 테이블만 · 백필 0 · FK 0(082 의 42804 규율 — reviewers.id 는 UUID 라
--   타입은 맞지만, 리뷰어를 지워도 변경 이력은 남아야 하므로 FK 를 걸지 않는다).
-- ★ DB CHECK 없음(어휘·사유 확장 시 저장 실패 방지 — 087 리뷰타입과 같은 규율).
-- 되돌리기 = DROP TABLE (기능은 라우트 미마운트).
CREATE TABLE IF NOT EXISTS reviewer_phone_changes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id    UUID NOT NULL,                 -- reviewers.id (FK 없음 — 삭제돼도 이력 보존)
  reviewer_name  TEXT NOT NULL DEFAULT '',
  old_phone      TEXT NOT NULL,
  new_phone      TEXT NOT NULL,
  old_phone8     TEXT NOT NULL DEFAULT '',
  new_phone8     TEXT NOT NULL DEFAULT '',
  moved          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 키 이관 결과(문의방·게이트·명단·블랙리스트)
  counts         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 변경 시점 영향 건수(주문·참여·문의 등)
  changed_by     TEXT NOT NULL DEFAULT '',
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rpc_reviewer ON reviewer_phone_changes(reviewer_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rpc_old8     ON reviewer_phone_changes(old_phone8);
