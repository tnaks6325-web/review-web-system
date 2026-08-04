-- 083: 광고주 접속 링크 — 로그인 요구 여부를 "명시 플래그"로 전환
--
-- 배경: 지금까지 링크의 로그인 게이트는 **활성 광고주 계정의 존재**로 판정했다
--   (auth.service.loginByLinkToken). 그래서 계정을 하나 발급하는 순간 그 업체의
--   고유 URL이 자동으로 "로그인 필요"가 되고, 계정을 두면서 링크는 열어 두는
--   선택지가 없었다(끄려면 계정을 비활성/삭제해야 했다).
--
-- 변경: 링크는 **기본 공개**, 로그인 요구는 관리자가 켜는 **명시 플래그**.
--   컬럼을 trackb_advertiser_links 에 두는 이유 = loginByLinkToken 이 이미 이 행을
--   SELECT 하므로 **쿼리 순증 0** 이고, 의미도 "이 링크가 로그인을 요구하는가"로 일치한다.
--
-- ★★ 배포 시 동작 불변(백필): 지금 활성 계정이 있어 로그인 게이트로 동작하던 업체는
--   TRUE 로 1회 백필한다. 즉 **머지 순간 광고주가 보는 동작은 그대로**이고,
--   앞으로 만드는 업체·계정만 기본 공개가 된다. (계정을 만들면 조용히 잠기던 것 → 관리자가 켜야 잠김)
--
-- ★ 재실행 안전(자기 가드): 컬럼을 NULL 허용으로 먼저 만들고 **login_required IS NULL 인 행만**
--   백필한 뒤 DEFAULT/NOT NULL 을 건다. 그래서 이 파일이 다시 돌아도(러너 오분류·수동 재실행)
--   관리자가 꺼 둔 값을 계정 존재만으로 되켜지 않는다.

ALTER TABLE trackb_advertiser_links ADD COLUMN IF NOT EXISTS login_required BOOLEAN;

UPDATE trackb_advertiser_links l
   SET login_required = EXISTS (
         SELECT 1 FROM advertiser_users au
          WHERE au.advertiser_id = l.advertiser_id AND au.active = TRUE)
 WHERE l.login_required IS NULL;

ALTER TABLE trackb_advertiser_links ALTER COLUMN login_required SET DEFAULT FALSE;
ALTER TABLE trackb_advertiser_links ALTER COLUMN login_required SET NOT NULL;

COMMENT ON COLUMN trackb_advertiser_links.login_required IS
  'TRUE 면 이 링크를 열었을 때 광고주 계정 로그인을 요구(requiresLogin). FALSE(기본) = 링크만으로 입장. 계정 존재 여부와 무관한 명시 플래그.';
