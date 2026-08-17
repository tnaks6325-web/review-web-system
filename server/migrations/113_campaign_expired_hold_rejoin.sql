-- 만료된 미제출 홀드는 재참여를 막지 않는다.
-- 기존 인덱스는 submitted 행까지 포함해, 애플리케이션의 명시적 submitted 차단과
-- 충돌할 수 있고 스윕 전의 만료 applied 행도 새 홀드를 막는다. submitted 차단은
-- /apply의 서버 판정이 담당하고, 이 인덱스는 동시에 살아 있는 applied 홀드만 보호한다.
DROP INDEX IF EXISTS uq_campaign_apps_active_hold;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_active_hold
  ON campaign_applications (campaign_id, phone8)
  WHERE status = 'applied';
