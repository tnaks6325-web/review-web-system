-- 217: 차례 타이머(결정 356) — 여러 명의로 참여하면 한 명의씩 시간이 흐른다.
-- ★ 대기 명의도 status='applied' + 미래 expires_at(= 예상 마감) — 새 상태 없음(결정 138) · NULL 없음.
-- ★ turn_starts_at IS NULL = 종전(동시) 홀드. 이 파일은 campaign_applications 의 기존 행을 바꾸지 않는다(진행 중 홀드 불변 · 백필 0).
-- ★ 기본값 없는 NULL 칸 추가 = 메타데이터만 바뀐다(표 다시 쓰기 없음). 한 문장 = 잠금 한 번.
-- ★ 색인 없음: 차례 조회는 (campaign_id, owner) 의 살아 있는 행뿐이라 uq_campaign_apps_active_hold(campaign_id 선두)를 탄다.
-- 되돌리기: 코드만 되돌리면 된다(옛 코드는 이 칸을 읽지 않는다). 칸은 지우지 않는다.
ALTER TABLE campaign_applications
  ADD COLUMN IF NOT EXISTS turn_starts_at TIMESTAMPTZ,   -- 내 차례 시작(당겨질 수만 있다)
  ADD COLUMN IF NOT EXISTS chain_ttl_min INT;            -- 참여 시점 내 제한시간(분) — 뒤에 공고 설정이 바뀌어도 그대로
