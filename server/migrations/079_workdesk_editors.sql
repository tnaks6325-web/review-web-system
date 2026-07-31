-- 079: 통합 작업대 편집 허용명단 (작업오더·모집공고 탭)
--
-- 배경: 두 탭은 AE(staff)에게도 열려 있지만, 작업오더 '접수'는 시트/탭을
--   tab_configs·campaigns 에 등록하는 단일 관문이고 공고 발행·수정은 정원·금액을 바꾼다.
--   → 역할이 아니라 **이름 명단**으로 편집 권한을 준다. 명단은 master/admin 이
--   통합 작업대에서 직접 관리하고, 후보는 인트라넷 직원DB에서 고른다.
--
-- ★ 059(reviewer_campaign_editors)와 같은 패턴 — 다만 그쪽 키는 phone8(리뷰어),
--   여기는 로그인 이름(직원)이다.
-- ★ name 은 JWT 의 name 과 대조한다: 인트라넷 SSO = display_name(실명),
--   관리자 로그인 = username. 표기 흔들림 흡수를 위해 조회 시 공백을 제거해 비교한다.

CREATE TABLE IF NOT EXISTS workdesk_editors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,                  -- 로그인 이름(= JWT name). 대조 키
  username   TEXT DEFAULT '',                -- 인트라넷 username(참고용)
  dept       TEXT DEFAULT '',                -- 부서·파트(참고용)
  active     BOOLEAN DEFAULT TRUE,
  added_by   TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 공백 제거 기준으로 중복 방지(같은 사람이 '박 세희'/'박세희'로 두 번 들어가지 않게)
CREATE UNIQUE INDEX IF NOT EXISTS uq_workdesk_editors_name
  ON workdesk_editors (REPLACE(name, ' ', ''));

-- 최초 명단(사용자 지정) — 이미 있으면 건드리지 않는다(재배포 시 되살아나지 않게)
INSERT INTO workdesk_editors (name, added_by)
SELECT v, 'migration:079' FROM (VALUES ('김수만'), ('박은비'), ('박세희')) AS t(v)
ON CONFLICT DO NOTHING;
