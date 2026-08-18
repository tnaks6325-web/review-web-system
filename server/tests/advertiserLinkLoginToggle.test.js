/*
 * 업체 전용 링크는 로그인 요구 설정을 다시 켤 수 없어야 한다.
 * 실행: node tests/advertiserLinkLoginToggle.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const auth = read('src/services/auth.service.js');
const service = read('src/services/trackB.service.js');
const workdesk = read('../frontend/workdesk.html');
const migration = read('migrations/118_disable_advertiser_link_login_required.sql');

const start = auth.indexOf('async function loginByLinkToken');
const end = auth.indexOf('async function loginByBrandToken', start);
const linkLogin = auth.slice(start, end);

assert.ok(start >= 0 && end > start, '업체 전용 링크 인증 함수를 찾을 수 있어야 합니다.');
assert.doesNotMatch(linkLogin, /login_required\s*===\s*true/, '링크 인증이 로그인 요구 플래그로 차단되면 안 됩니다.');
assert.doesNotMatch(linkLogin, /requiresLogin\s*:\s*true/, '링크 인증 API가 로그인 요구 응답을 반환하면 안 됩니다.');
assert.match(migration, /SET\s+login_required\s*=\s*FALSE/i, '기존 링크의 로그인 요구 값을 해제해야 합니다.');

const setStart = service.indexOf('async function setAdvertiserLinkLoginRequired');
const setEnd = service.indexOf('// ── 담당 AE', setStart);
const setter = service.slice(setStart, setEnd);
assert.match(setter, /SET login_required = FALSE/, '기존 관리 API로 로그인 요구를 다시 켤 수 있으면 안 됩니다.');
assert.doesNotMatch(setter, /required === true|required === 'true'/, '요청값으로 로그인 요구를 다시 켜면 안 됩니다.');
assert.match(workdesk, /전용 링크는 항상 로그인 없이 열립니다/, '관리 화면에 무로그인 정책을 안내해야 합니다.');

console.log('✅ advertiserLinkLoginToggle: 업체 전용 링크 무로그인 정책 가드 통과');
