-- ═══════════════════════════════════════════════════════════════════════
-- 168 — 리뷰 검수 결과를 리뷰어에게 보여주기 (사용자 확정 2026-09-26)
--
-- 배경: 제출 응답에서 검수를 떼어내(속도) 리뷰어에게는 먼저 "확인 중"을 보여주고,
--       검사가 끝나면 "제출완료" 또는 "제출 반려"로 바뀐다. 반려 사실은
--       리뷰 내역과 1:1 문의방 양쪽에 남는다.
--
-- ★ 컬럼 추가 + 인덱스 + 기준선 시드만 — 백필 0 · CHECK 0 · FK 0.
--   배포 즉시 동작 불변(기준선 이전 제출분은 종전대로 '제출완료'로만 보인다).
-- ═══════════════════════════════════════════════════════════════════════

-- 같은 반려를 문의방에 두 번 남기지 않기 위한 표시.
--   ★ 값이 NULL = 아직 안 보냄. 보낸 뒤에만 시각이 찍힌다(재검수해도 다시 안 보낸다).
ALTER TABLE review_inspections
  ADD COLUMN IF NOT EXISTS reviewer_notified_at TIMESTAMPTZ;

-- 리뷰어 화면은 (시트·탭·행)으로 그 행의 검수 상태를 모아 읽는다.
--   기존 인덱스는 (sheet_id, tab_name, status) 라 row_index 조회를 못 탄다.
CREATE INDEX IF NOT EXISTS idx_review_inspect_row
  ON review_inspections(sheet_id, tab_name, row_index);

-- ★★ 소급 금지 기준선 (062 캡처 컷오프와 같은 장치)
--   이 시각 **이전** 제출분은 리뷰어 화면에서 종전대로 '제출완료'로만 보인다.
--   없으면 배포 순간 과거 제출 건이 전부 '확인 중'으로 뒤집힌다(검수 행이 없거나
--   옛 형태라 판정이 갈린다). ON CONFLICT DO NOTHING = 재배포 시 재실행 안전.
INSERT INTO app_settings (key, value, updated_at)
VALUES ('review_check_visible_from', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), NOW())
ON CONFLICT (key) DO NOTHING;
