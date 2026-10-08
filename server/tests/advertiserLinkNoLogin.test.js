/*
 * 업체 전용 링크는 계정 설정과 무관하게 로그인 없이 열려야 한다.
 * 실행: node tests/advertiserLinkNoLogin.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverRoot = path.join(__dirname, '..');
const auth = fs.readFileSync(path.join(serverRoot, 'src/services/auth.service.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(serverRoot, '..', 'frontend', 'workdesk.html'), 'utf8');
const migrationPath = path.join(serverRoot, 'migrations/118_disable_advertiser_link_login_required.sql');

const start = auth.indexOf('async function loginByLinkToken');
const end = auth.indexOf('async function loginByBrandToken', start);
const loginByLinkToken = auth.slice(start, end);

assert.ok(fs.existsSync(migrationPath), '기존 업체 링크의 로그인 요구를 해제하는 마이그레이션이 필요합니다.');
assert.doesNotMatch(loginByLinkToken, /login_required\s*===\s*true/,
  '유효한 업체 전용 링크는 login_required 값 때문에 로그인 화면으로 보내면 안 됩니다.');
assert.doesNotMatch(loginByLinkToken, /requiresLogin\s*:\s*true/,
  '전용 링크 로그인 API는 로그인 요구 응답을 반환하면 안 됩니다.');

const linkStart = workdesk.indexOf('function _advLinkHtml(a)');
const linkEnd = workdesk.indexOf('async function _advLinkReload()', linkStart);
const linkHtml = workdesk.slice(linkStart, linkEnd);
assert.ok(linkStart >= 0 && linkEnd > linkStart,
  '광고주 접속 링크 관리·복사 함수를 찾을 수 있어야 합니다.');
assert.match(linkHtml, /onclick="advLinkCopy\(\)"/,
  '광고주 URL 복사는 접속 링크 관리 화면의 단일 버튼으로 제공해야 합니다.');
assert.equal((linkHtml.match(/advLinkCopy\(\)/g) || []).length, 1,
  '접속 링크 관리 화면에는 URL 복사 버튼이 하나만 있어야 합니다.');
// ★ 업체관리(목록·상세) 안의 중복 복사 경로는 계속 금지한다(2026-09-09 통합).
assert.doesNotMatch(workdesk, /function _ovmCopyAdvLink\(|ovm-lkcopy/,
  '업체관리 목록·상세의 중복 복사 경로가 남으면 같은 광고주 URL을 여러 번 복사하게 된다.');
// ★ 결정 218(사용자 확정 2026-10-09): 작업보드 상단 [🏢 광고주링크] 한 곳만 추가 허용 — 업체관리 밖이고,
//   같은 링크(advertiser-link ensure)를 쓴다. 다른 자리에 또 생기면 실패한다.
assert.equal((workdesk.match(/onclick="copyAdvertiserLink\(\)"/g) || []).length, 1,
  '광고주 링크 복사는 업체관리 「광고주 접속 링크」 + 작업보드 상단 버튼 한 곳까지만.');
assert.match(workdesk, /const advLinkBtn=_isInternalRole\(\)\?`<button[^`]*onclick="copyAdvertiserLink\(\)"/,
  '작업보드 버튼은 작업보드 상단(advLinkBtn)에만 있어야 한다.');
const cal = workdesk.slice(workdesk.indexOf('async function copyAdvertiserLink('), workdesk.indexOf('async function copyAdvertiserLink(') + 1600);
assert.match(cal, /action:'for-tab'/, '작업보드 버튼은 서버가 현재 업체를 정하고 링크를 바꾸지 않는다(for-tab → ensure — 회전 금지).');
assert.doesNotMatch(cal, /action:'generate'/, '작업보드 버튼에서 링크 회전 금지.');
assert.match(workdesk, /광고주 접속 링크/,
  '유일한 진입점을 광고주 접속 링크로 명확히 표기해야 합니다.');

console.log('✅ advertiserLinkNoLogin: 업체 전용 링크 무로그인 회귀 가드 통과');
