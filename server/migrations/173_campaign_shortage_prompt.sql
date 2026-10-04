-- 173: 어제 모집 부족 인원 처리 팝업 (사용자 확정 2026-10-02)
-- "기간 늘려 뒤에 붙이기"를 고른 공고는 앞으로 묻지 않는다 — 그 표시만 남긴다(정원·계획 무변경).
-- 하루 단위 처리 기록은 campaign_plan_events(action='shortage_decision')를 재사용한다(신규 테이블 0).
-- ★ 컬럼 추가만 · 백필 0 · CHECK 0 → 배포 즉시 동작 불변.
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS shortage_prompt_off_at TIMESTAMPTZ;
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS shortage_prompt_off_by TEXT;
