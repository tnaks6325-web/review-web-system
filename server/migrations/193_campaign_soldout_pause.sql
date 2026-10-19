-- 193: 옵션 없는 공고도 품절로 잠시 멈춘다 — 공고 전체 멈춤 칸 3개 (결정 259 · 사용자 확정 2026-10-19)
--   184(결정 229)는 상품(campaign_options) 단위로만 멈췄다 → 상품을 나누지 않은 공고는 멈출 대상이 없어
--   작업조건 카드에 [품절로 멈추기]가 없고, 품절 신고가 와도 [확인했어요] 알림만 떴다.
--   ① recruit_campaigns 에 멈춤 칸 3개 — 상태(status)와 **따로** 둔다(184 와 같은 이유: status 에 넣으면
--      공고 수정 창이 active/closed/draft 만 저장해 저장 한 번에 멈춤이 풀리고, 마감과 구별되지 않는다).
--   ② soldout_paused_at IS NULL = 열림(종전과 같음 — 기존 행 동작 불변).
--   ★ 추가만 하는 변경 — 기존 칸·행을 바꾸지 않는다. 신고·알림 원장은 184 표를 그대로 쓴다(opt_key = '' = 공고 전체).
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS soldout_paused_at TIMESTAMPTZ NULL;
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS soldout_paused_reason TEXT NOT NULL DEFAULT '';   -- 'manual' | 'auto_soldout'
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS soldout_paused_by TEXT NOT NULL DEFAULT '';
