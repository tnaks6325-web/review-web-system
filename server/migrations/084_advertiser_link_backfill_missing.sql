-- 084: 083 백필의 사각지대 메우기 — "활성 계정은 있는데 링크 행이 아직 없는" 업체
--
-- 083 은 trackb_advertiser_links **행이 이미 있는** 업체만 TRUE 로 백필했다. 그런데 링크 행은
-- 058 에서 일괄 생성되지 않고 **관리자가 업체 패널을 열 때 ensureAdvertiserLink 로 지연 생성**된다.
-- 그래서 활성 계정이 있지만 아직 패널을 연 적 없는 업체는 백필 대상이 아니었고, 배포 후 패널을 여는
-- 순간 DEFAULT FALSE 로 행이 생겨 **계정이 있는데도 공개 링크**가 된다(구코드였다면 로그인 게이트).
-- → "배포 시 동작 불변" 약속이 그 업체들에서만 깨진다. 코드리뷰에서 잡힌 실제 구멍.
--
-- 조치: 그 업체들의 링크 행을 지금 만들어 두되 login_required = TRUE 로 넣는다.
--   ★ 대상은 **활성 계정 보유 업체로 한정** — 계정 없는 업체까지 만들 필요가 없고(어차피 기본 공개),
--     최소 침습이 재실행·되돌리기 모두 쉽다.
--   ★ 토큰은 서비스와 같은 규격(랜덤 24바이트 base64url) 을 SQL 로 생성한다.
--     gen_random_bytes 는 pgcrypto — 없으면 이 파일은 실패하고 기록되지 않아 다음 배포에 재시도된다.
--   ★ ON CONFLICT DO NOTHING = 이미 행이 있으면 손대지 않는다(관리자가 꺼 둔 값 보존).
--   ★ status='ended' 거래처는 제외(loginByLinkToken 이 어차피 거부).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO trackb_advertiser_links (advertiser_id, token, active, login_required, created_by)
SELECT a.id,
       translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_'),
       TRUE, TRUE, 'migration:084'
  FROM advertisers a
 WHERE a.status <> 'ended'
   AND EXISTS (SELECT 1 FROM advertiser_users au WHERE au.advertiser_id = a.id AND au.active = TRUE)
   AND NOT EXISTS (SELECT 1 FROM trackb_advertiser_links l WHERE l.advertiser_id = a.id)
ON CONFLICT (advertiser_id) DO NOTHING;
