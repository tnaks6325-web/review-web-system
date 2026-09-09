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

const publicCopyStart = workdesk.indexOf('function copyAdvertiserLink()');
const publicCopyEnd = workdesk.indexOf('function renderLogin(', publicCopyStart);
const publicCopy = workdesk.slice(publicCopyStart, publicCopyEnd);
assert.ok(publicCopyStart >= 0 && publicCopyEnd > publicCopyStart,
  '업체 화면의 광고주 URL 복사 함수를 찾을 수 있어야 합니다.');
assert.match(publicCopy, /_ovmCopyAdvLink\(i\)/,
  '업체 화면의 빠른 복사는 무로그인 전용 URL 발급 경로를 재사용해야 합니다.');
assert.doesNotMatch(publicCopy, /_shareLinkCopy/,
  '업체 화면의 빠른 복사가 내부 전용 공유 URL을 만들면 광고주에게 로그인 화면이 뜬다.');
assert.match(workdesk, /광고주 URL 복사/,
  '로그인이 필요한 내부 업체 링크와 혼동되지 않도록 버튼을 광고주 URL로 표기해야 합니다.');

console.log('✅ advertiserLinkNoLogin: 업체 전용 링크 무로그인 회귀 가드 통과');
