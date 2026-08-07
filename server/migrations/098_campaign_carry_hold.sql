-- ═══════════════════════════════════════════════════════════
-- 098: 이월 보류·수동 반영 (carry_mode)
--
-- 배경: 자연 미달분(이월)이 무조건 다음날 정원에 자동으로 얹힌다(066). 업체가
--   "미달분은 나중에 몰아서"를 요청하면 매일 아침 손으로 그날 인원을 줄여야 했다.
--   시안 = frontend/docs/이월보류_수동반영_와이어프레임.html (사용자 확정 3건).
--
-- carry_mode: 'auto'(기본 = 현행 자동 이월) | 'hold'(보류 — 자동 이월을 멈추고
--   관리자가 카드 ⏸ 칩·[📅 인원] 팝업에서 골라 반영). 총량 불변 — 반영하지 않아도
--   총량 도달까지 기본 일건수로 모집이 계속되어 물량이 사라지지 않는다.
-- ★ DB CHECK 없음(어휘 확장 시 저장 실패 — 087 규율). 백필 0 = 기존 공고 전부 'auto'(현행 불변).
-- ★ 반영 이력은 095의 campaign_plan_events(action='carry_apply')를 재사용 — 신규 테이블 0.
-- ═══════════════════════════════════════════════════════════
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS carry_mode TEXT DEFAULT 'auto';

-- 보류 잔량(누적 미달)의 소급 기준선 — 이 키가 "언제부터 셀지"를 고정한다.
-- 없으면 몇 주째 진행 중인 캠페인을 보류로 전환하는 순간 과거 미달분이 수십 명으로
-- 잡혀 오해를 부른다(066 이월 기준선과 같은 소급 차단 장치).
-- ON CONFLICT DO NOTHING = 재배포해도 기준선이 앞당겨지지 않는다(멱등).
INSERT INTO app_settings (key, value, updated_at)
VALUES ('campaign_carry_hold_start', to_char((NOW() AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD'), NOW())
ON CONFLICT (key) DO NOTHING;
