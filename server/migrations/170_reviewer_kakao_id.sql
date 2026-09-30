-- 170: 리뷰어 본계정 카카오톡 아이디(사용자 확정 2026-09-30).
--   리뷰 미작성자에게 담당자가 카톡으로 연락하기 위한 값. 가입 시 필수, 기존 회원은 내정보에서 등록.
--   ★ 본계정에만 둔다(타계정마다 받지 않음 — 사용자 확정).
--   ★ 컬럼 추가만 · 백필 0 · CHECK 0 (형식 검사는 utils/kakaoId.js 단일 출처).
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS kakao_id TEXT NOT NULL DEFAULT '';
