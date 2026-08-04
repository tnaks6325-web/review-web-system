/**
 * 광고주 접속 링크 — "계정 존재 = 자동 로그인 게이트"에서 "명시 토글"로 전환(083) 회귀가드.
 *
 * 고정하는 것:
 *   A. 마이그레이션 — 컬럼 추가 + **자기 가드 백필**(login_required IS NULL 인 행만) + DEFAULT/NOT NULL.
 *      ★ 백필 가드가 없으면 파일이 다시 돌 때 관리자가 꺼 둔 업체가 계정 존재만으로 되켜진다.
 *   B. 서버 게이트 — loginByLinkToken 이 login_required 를 보고, **계정 존재(advertiser_users)로 판정하지 않는다**.
 *   C. 토글 라우트/서비스 배선 — action 'login-required', adminOrMaster 게이트.
 *   D. 프론트 — 토글 배선 + 배지 판정이 lockOn(서버 플래그) 기준 + **높이 예약**(토글 ON/OFF 에 카드 높이 불변)
 *      + 미사용 상태에서 계정 입력이 막히지 않음(막으면 계정을 못 만들어 토글을 켤 수 없는 교착).
 *
 * 실행: node tests/advertiserLinkLoginToggle.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const RF = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// ═══ A. 마이그레이션 083 ═══
const mig = R('migrations/083_advertiser_link_login_required.sql');
ok(/ALTER TABLE trackb_advertiser_links ADD COLUMN IF NOT EXISTS login_required BOOLEAN/.test(mig),
  'A1: 컬럼 추가(IF NOT EXISTS = 재실행 안전)');
ok(/UPDATE trackb_advertiser_links[\s\S]*WHERE l\.login_required IS NULL/.test(mig),
  'A2: 백필은 login_required IS NULL 인 행만 — 재실행해도 관리자가 끈 값을 되켜지 않는다');
ok(/EXISTS \([\s\S]*advertiser_users[\s\S]*active = TRUE/.test(mig),
  'A3: 백필 기준 = 지금 활성 계정이 있는 업체(배포 시 광고주가 보는 동작 불변)');
ok(/SET DEFAULT FALSE/.test(mig) && /SET NOT NULL/.test(mig), 'A4: 기본 FALSE(공개) + NOT NULL');
ok(!/DROP\s+(TABLE|COLUMN)/i.test(mig), 'A5: 파괴적 구문 없음');

// ═══ B. 서버 게이트 ═══
const authSrc = R('src/services/auth.service.js');
const fn = authSrc.slice(authSrc.indexOf('async function loginByLinkToken'),
  authSrc.indexOf('async function addAdvertiserUser'));
ok(/l\.login_required/.test(fn), 'B1: 링크 조회 SELECT 에 login_required 포함(쿼리 순증 0 — 기존 행에서 읽는다)');
ok(/rows\[0\]\.login_required === true/.test(fn), 'B2: 게이트 판정 = 명시 플래그');
ok(!/FROM advertiser_users/.test(fn),
  'B3: ★ 계정 존재 조회가 게이트에서 제거됨 — 계정을 발급해도 링크가 자동으로 잠기지 않는다');
ok(/requiresLogin: true/.test(fn), 'B4: 잠긴 경우 requiresLogin 계약 유지(프론트 로그인 화면 전환)');

// ═══ C. 토글 라우트·서비스 ═══
const routes = R('src/routes/trackB.routes.js');
const linkRoute = routes.slice(routes.indexOf("router.post('/advertiser-link',"),
  routes.indexOf("router.post('/advertiser-link-login',"));
ok(/authMiddleware, adminOrMasterMiddleware/.test(linkRoute), 'C1: 링크 라우트 = authMiddleware + adminOrMaster');
ok(/action === 'login-required'/.test(linkRoute) && /setAdvertiserLinkLoginRequired/.test(linkRoute),
  'C2: action=login-required → 서비스 위임');

const svcSrc = R('src/services/trackB.service.js');
const setFn = svcSrc.slice(svcSrc.indexOf('async function setAdvertiserLinkLoginRequired'),
  svcSrc.indexOf('// ── 담당 AE(inad_pm) 매칭'));
ok(/SELECT 1 FROM advertiser_users[\s\S]*active = TRUE/.test(setFn) && /if \(want\)/.test(setFn),
  'C3: 켤 때만 활성 계정 존재를 요구(계정 0개로 켜면 아무도 못 들어온다)');
ok(!/DELETE FROM advertiser_users|UPDATE advertiser_users/.test(setFn),
  'C4: ★ 토글은 계정을 지우거나 비활성화하지 않는다(다시 켜면 그대로 사용)');
ok(/ensureAdvertiserLink/.test(setFn), 'C5: 링크 행이 없으면 ensure 후 적용(업체마다 URL 보유 계약 유지)');
ok(/login_required AS "loginRequired"/.test(svcSrc), 'C6: getAdvertiserLink 가 loginRequired 반환');
ok(/setAdvertiserLinkLoginRequired,/.test(svcSrc.slice(svcSrc.lastIndexOf('module.exports'))),
  'C7: export 배선');

// ═══ D. 프론트(workdesk.html) ═══
const wd = RF('frontend/workdesk.html');
const linkHtml = wd.slice(wd.indexOf('function _advLinkHtml'), wd.indexOf('async function _advLinkReload'));
ok(/const lockOn=!!\(lk && lk\.loginRequired\)/.test(linkHtml), 'D1: 배지 판정 = 서버 플래그(lockOn)');
ok(!/hasAcct/.test(linkHtml), 'D2: ★ 계정 존재로 배지를 정하던 판정 제거(서버와 화면이 갈리지 않는다)');
ok(/lockbadge lock/.test(linkHtml) && /lockbadge open/.test(linkHtml), 'D3: 🔒/🔓 배지 유지');

const acctHtml = wd.slice(wd.indexOf('function _advAcctHtml'), wd.indexOf('async function _advAcctLoginToggle') > 0
  ? wd.indexOf('async function _advAcctLoginToggle') : wd.indexOf('// 광고주 계정 사용/미사용 토글'));
ok(/role="switch"/.test(acctHtml) && /aria-checked="\$\{lockOn\?'true':'false'\}"/.test(acctHtml),
  'D4: 토글 스위치(접근성 role/aria-checked)');
ok(/advAcctLoginToggle\('\$\{esc\(a\.id\)\}',\$\{lockOn\?'false':'true'\}\)/.test(acctHtml), 'D5: 토글 배선(현재값 반전)');
ok(/\$\{\(!lockOn && !hasActive\)\?'disabled':''\}/.test(acctHtml),
  'D6: 활성 계정 0개면 켜기 비활성(서버 거부와 같은 규칙 — 실패할 클릭을 만들지 않는다)');
ok(/class="acctbody\$\{lockOn\?'':' dim'\}"/.test(acctHtml), 'D7: 미사용이면 계정 영역 흐리게');

ok(/async function advAcctLoginToggle/.test(wd), 'D8: 토글 핸들러 존재');
const toggleFn = wd.slice(wd.indexOf('async function advAcctLoginToggle'), wd.indexOf('async function _advAcctReload'));
ok(/action:'login-required'/.test(toggleFn), 'D9: 라우트 action 일치');
ok(/if\(!on && !confirm\(/.test(toggleFn),
  'D10: 보안이 풀리는 방향(ON→OFF)에서만 확인 — 켜는 쪽은 마찰 없이');
ok(/_advLinkReload\(\)/.test(toggleFn), 'D11: 저장 후 재조회(두 카드가 같은 서버 값을 다시 그린다)');

// 높이 안정 — 토글 ON/OFF 로 문구 줄 수가 달라져도 카드 높이가 흔들리지 않도록 2줄분 예약
const css = wd.slice(0, wd.indexOf('</style>'));
ok(/\.linkhint\{[^}]*min-height:35px/.test(css), 'D12: 링크 안내문 2줄분 높이 예약');
ok(/\.acctnote\{[^}]*min-height:55px/.test(css), 'D13: 계정 안내문 2줄분 높이 예약(패딩 포함)');
ok(/\.sect \.st\.sthead\{[^}]*min-height:23px/.test(css), 'D14: 토글이 들어간 헤더 줄 높이 고정(스위치 유무로 안 튄다)');
ok(!/\.st\{[^}]*display:flex/.test(css),
  'D15: ★ 공용 .st 를 flex 로 바꾸지 않음 — 토글 헤더만 .sthead 로 스코프(다른 섹션 무영향)');

// ★ 미사용 상태에서 계정 입력이 막히면 계정을 못 만들어 토글을 켤 수 없다(교착) → 클릭 차단 금지
const dimRule = (css.match(/\.acctbody\.dim\{[^}]*\}/) || [''])[0];
ok(dimRule && !/pointer-events\s*:\s*none/.test(dimRule),
  'D16: ★ 흐리게만 하고 클릭은 막지 않는다(막으면 계정 발급 불가 → 토글을 켤 수 없는 교착)');
ok(!/\.acctbody\.dim [^{]*\{[^}]*pointer-events\s*:\s*none/.test(css), 'D17: 자식 요소도 클릭 차단 없음');

// 마지막 활성 계정 제거 시 잠금 사전 경고(조용한 잠금 금지)
ok(/function _advAcctLockoutOk/.test(wd), 'D18: 잠금 경고 헬퍼');
ok(/_advAcctLockoutOk\(name\)/.test(wd.slice(wd.indexOf('async function advAcctToggle'))), 'D19: 비활성화 경로 배선');
ok(/_advAcctLockoutOk\(name\)/.test(wd.slice(wd.indexOf('async function advAcctDelete'))), 'D20: 삭제 경로 배선');

console.log(`✅ advertiserLinkLoginToggle 테스트 전체 통과 (${n}케이스)`);
