-- 216: 무인증 사진 통로 2곳의 허용 목록 (결정 352)
--
-- 배경: GET /api/drive/image/:id 와 GET /api/order/guide-image/:id 는 로그인 없이 파일 번호만으로
--   드라이브의 "아무 파일"이나 내줬다(소유자 계정으로 읽으므로 비공개 이체결과 파일도 — 결정 316).
--   이제 두 통로는 "우리 DB 에 기록된 번호"만 내준다. 판정은 번호 하나에 인덱스 조회 1회.
--
-- ① drive/image 출처 칸 중 인덱스가 없던 칸에 인덱스를 보탠다(가산 · 쓰기 경로 동작 불변).
--    기존 관례대로 비-CONCURRENTLY(migrate 가 파일을 한 번에 실행 — 051·144·168 과 같은 방식).
--    부분 인덱스(IS NOT NULL) — 조회는 "칸 = 번호" 라 NULL 줄은 볼 일이 없다(같은 이유로 표 크기도 작다).
-- ② guide-image 는 주소가 여러 글 칸에 문장째 섞여 저장돼 인덱스로 찾을 수 없다 → 번호 목록 표
--    guide_image_files 를 두고, 올리는 3곳(order·cs·reviewer 업로드)이 주소를 돌려주기 전에 등록한다.
--    지난 사진은 아래 DO 블록이 public 스키마의 모든 글 칸(text·varchar·json·jsonb·text[])에서 주소를 찾아
--    한 번 들여온다(bytea = 이체결과 파일 원본 등은 읽지 않는다). 읽기만 하므로 다른 쓰기를 막지 않는다.
--    ★ 표 만들기와 들여오기는 한 파일(=한 묶음) — 들여오기가 실패하면 표도 안 생겨 부팅 점검
--      (REQUIRED_TABLES)이 새 배포를 거부하고 옛 배포가 그대로 돈다(빈 목록으로 사진이 전부 막히는 일 없음).
--
-- 롤백: DROP TABLE IF EXISTS guide_image_files;
--       DROP INDEX IF EXISTS idx_os_capture_file_id, idx_os_capture_file_id_2, idx_review_edit_old_file,
--         idx_review_edit_new_file, idx_pss_capture_file, idx_rel_capture_file, idx_rel_context_file,
--         idx_payment_archive_drive_file;
--       (코드를 되돌리면 옛 코드는 이 표·인덱스를 읽지 않는다 — 남겨 둬도 충돌 없음)

CREATE INDEX IF NOT EXISTS idx_os_capture_file_id
  ON order_submissions (capture_file_id) WHERE capture_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_os_capture_file_id_2
  ON order_submissions (capture_file_id_2) WHERE capture_file_id_2 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_review_edit_old_file
  ON review_edit_requests (old_file_id) WHERE old_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_review_edit_new_file
  ON review_edit_requests (new_file_id) WHERE new_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pss_capture_file
  ON purchase_submission_sessions (capture_file_id) WHERE capture_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_capture_file
  ON reviewer_event_logs (capture_file_id) WHERE capture_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_context_file
  ON reviewer_event_logs ((context->>'fileId')) WHERE (context->>'fileId') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_archive_drive_file
  ON payment_result_drive_archive (drive_file_id) WHERE drive_file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS guide_image_files (
  file_id     TEXT PRIMARY KEY,                 -- Drive 파일 번호(guide-image 주소의 끝)
  source      TEXT NOT NULL DEFAULT '',         -- upload:order · upload:intranet · upload:cs-admin · upload:cs-reviewer · backfill:<표>
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  r RECORD;
  cols TEXT;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('guide_image_files', '_migrations')
  LOOP
    SELECT string_agg(format('COALESCE(%I::text, %L)', a.attname, ''), ' || '' '' || ')
      INTO cols
      FROM pg_attribute a
     WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid IN ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype);
    CONTINUE WHEN cols IS NULL;
    EXECUTE format($q$
      INSERT INTO guide_image_files (file_id, source)
      SELECT DISTINCT m[1], %L
        FROM (SELECT %s AS blob FROM public.%I) s,
             LATERAL regexp_matches(s.blob, '/api/order/guide-image/([-_A-Za-z0-9]{20,})', 'g') m
       WHERE s.blob LIKE '%%/api/order/guide-image/%%'
      ON CONFLICT (file_id) DO NOTHING
    $q$, 'backfill:' || r.relname, cols, r.relname);
  END LOOP;
END $$;
