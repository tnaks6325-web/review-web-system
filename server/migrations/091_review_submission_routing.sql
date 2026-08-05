-- 091: 제출 이미지 자동 분류·이동(파일 라우팅) 이력
--   review_submissions 원장에 "이 파일이 어느 슬롯에서 옮겨져 왔는가"를 남긴다.
--   ★ 이동 이력 없는 자동 이동 금지(조용한 자동수정 금지) — 되돌리기의 유일한 재료.
--   ★ 라우팅 기록은 전부 fail-soft UPDATE(핫패스 INSERT 컬럼 목록 무변경)라
--     이 마이그레이션이 늦게 붙어도 업로드·제출은 죽지 않는다(라우팅 이력만 생략).
-- 와이어프레임: frontend/docs/리뷰제출_이미지_자동분류_와이어프레임.html

ALTER TABLE review_submissions ADD COLUMN IF NOT EXISTS routed_from_slot TEXT;
ALTER TABLE review_submissions ADD COLUMN IF NOT EXISTS routed_at TIMESTAMPTZ;
ALTER TABLE review_submissions ADD COLUMN IF NOT EXISTS routed_by TEXT;

COMMENT ON COLUMN review_submissions.routed_from_slot IS '자동 분류로 이동되기 전의 원래 슬롯(NULL=이동 없음). 값이 있으면 재라우팅 금지(핑퐁 방지) + 되돌리기 가능';
COMMENT ON COLUMN review_submissions.routed_by IS '이동 주체: auto:upload | sweep:<계정> | revert 등';
