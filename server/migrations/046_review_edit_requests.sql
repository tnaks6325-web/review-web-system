-- 046: 리뷰 이미지 수정요청 (리뷰어 제출 → 관리자 승인 → [리뷰] 폴더 파일 교체)
--
-- 리뷰어가 제출한 리뷰 이미지를 잘못 올린 경우, 무인증(phone8 강한-키 게이트)으로
-- "교체 요청"을 올리면 새 파일은 [리뷰]/[수정대기] 폴더에 스테이징만 되고
-- 실제 [리뷰] 폴더의 파일은 관리자가 승인할 때에만 교체된다(즉시 교체 금지).
--
-- 데이터 손실 방어: 승인 시 "새 파일 배치 → DB 포인터 스왑 → 구 파일 휴지통 이동" 순서.
--   구 파일은 하드삭제가 아니라 휴지통 이동(복구 가능)이라 어떤 단계에서 실패해도 리뷰가 유실되지 않는다.
CREATE TABLE IF NOT EXISTS review_edit_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id         TEXT NOT NULL,
  tab_name         TEXT NOT NULL,
  tab_gid          TEXT,
  row_index        INTEGER,
  slot_key         TEXT NOT NULL DEFAULT 'review',
  reviewer_name    TEXT,
  phone8           TEXT NOT NULL,          -- 요청 리뷰어 신원(서버 파생, 소유권 검증 통과분)
  campaign_label   TEXT,                   -- 표시용 스냅샷(관리자 위젯/리뷰어 내역)
  -- 교체 대상(구 파일)
  old_file_id      TEXT,
  old_file_url     TEXT,
  old_file_name    TEXT,
  -- 스테이징된 새 파일
  new_file_id      TEXT,
  new_file_url     TEXT,
  new_file_name    TEXT,
  new_parent_id    TEXT,                   -- 스테이징 폴더([수정대기]) ID (승인 이동 시 원부모)
  target_folder_id TEXT,                   -- 승인 시 이동 대상([리뷰] 또는 슬롯 서브폴더) ID
  reason           TEXT,                   -- 리뷰어 사유(정화·길이제한)
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
  admin_note       TEXT,                   -- 관리자 처리 메모(반려 사유 등) — 리뷰어에게 표시
  resolved_by      TEXT,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 한 (시트,탭,행,슬롯)당 대기중(pending) 요청은 1건만 — 중복/스팸 차단(부분 유니크)
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_edit_open
  ON review_edit_requests (sheet_id, tab_name, row_index, slot_key)
  WHERE status = 'pending';

-- 관리자 위젯: 대기중 목록 빠른 조회
CREATE INDEX IF NOT EXISTS idx_review_edit_pending
  ON review_edit_requests (status)
  WHERE status = 'pending';

-- 리뷰어 본인 요청내역 조회
CREATE INDEX IF NOT EXISTS idx_review_edit_phone8
  ON review_edit_requests (phone8);

CREATE INDEX IF NOT EXISTS idx_review_edit_created
  ON review_edit_requests (created_at DESC);
