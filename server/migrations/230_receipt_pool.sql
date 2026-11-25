-- 230: 영수증리뷰 2단계 — 영수증 묶음(receipt_pool) + 비공개 영수증 사진 목록(receipt_review_files) — 결정 418·420 (2026-11-25).
--
-- ① receipt_review_files = 「영수증리뷰 영수증 사진으로 올라온 드라이브 파일」 목록(파일 번호 기본키).
--    올리는 곳 = POST /api/order/receipt-review-image(인트라넷 X-Intake-Key · 내부 담당자) 하나 — 주소를 돌려주기 전에 여기 적는다.
--    ★★ 결정 352 사진 통로의 **거절 목록(PRIVATE_SOURCES)** 에 들어간다 — 무인증 통로(drive/image · guide-image)·엣지(354)는
--      이 번호를 어디에 함께 적혀 있어도 404 로 거절한다(드라이브 읽기 0). 영수증에는 결제 카드·시각이 찍혀 있다.
--    ★ 접수 때 오더 계약의 영수증 번호가 **전부 이 목록에 있어야** 영수증 묶음을 깐다(없으면 접수를 끝내지 않음 —
--      공개 안내 사진·이체결과 파일 번호를 영수증으로 끼워 넣어 직원·리뷰어 통로로 꺼내 가는 길을 막는다).
-- ② receipt_pool = 한 줄 = 「영수증 한 장 = 리뷰어 한 명 자리」. 접수(무시트 작업표 생성) 때 작업오더 계약에서 한 번 만든다.
--      pool_seq = AE 가 붙인 순서(1..N · 작업표 「영수증」 칸의 `N번`) · seq = 그 자리의 작업표 줄 번호(campaign_participants.seq)
--      file_id  = 영수증 사진(드라이브 · 비공개 · receipt_review_files 에 있는 번호만) · status = 'open' | 'cancelled'
--    ★ 3단계(참여)에서 campaign_applications.receipt_pool_id + 부분 유일 색인(살아 있는 신청 하나만)을 더한다 —
--      예약리뷰 228(booking_slot_id)과 같은 방식(영수증 한 장이 두 사람에게 가지 않게 하는 것은 유일 색인이 맡는다).
-- ★ 가산 전용 · CHECK/FK 없음(082·137 규율) · 러너가 매 기동 시 재실행하므로 멱등.
-- 롤백: DROP TABLE receipt_pool; DROP TABLE receipt_review_files;
--   (코드가 먼저 되돌아가 있어야 한다 — 표가 없으면 사진 통로 판정 조회가 실패해 fail-open(사진만)이 되고,
--    영수증 탭 판정은 조회 실패 = 영수증 탭으로 보고 자동 정리를 쉰다)

CREATE TABLE IF NOT EXISTS receipt_review_files (
  file_id     TEXT PRIMARY KEY,
  source      TEXT,
  mime_type   TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipt_pool (
  id             BIGSERIAL PRIMARY KEY,
  work_order_id  TEXT NOT NULL,
  sheet_id       TEXT NOT NULL,
  tab_name       TEXT NOT NULL,
  seq            INTEGER,
  pool_seq       INTEGER NOT NULL,
  file_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_pool_no   ON receipt_pool (sheet_id, tab_name, pool_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_pool_row  ON receipt_pool (sheet_id, tab_name, seq) WHERE seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_pool_file ON receipt_pool (sheet_id, tab_name, file_id);
CREATE INDEX IF NOT EXISTS idx_receipt_pool_file_id ON receipt_pool (file_id);
CREATE INDEX IF NOT EXISTS idx_receipt_pool_open ON receipt_pool (sheet_id, tab_name, pool_seq) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_receipt_pool_wo   ON receipt_pool (work_order_id);
