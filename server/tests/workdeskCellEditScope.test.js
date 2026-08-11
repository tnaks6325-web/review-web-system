/*
 * 작업보드 셀 편집 권한 회귀가드.
 *
 * 직원은 담당자 배정과 무관하게 모든 작업표의 값을 편집·붙여넣기할 수 있어야 한다.
 * 다만 마감·정산 등 다른 작업은 기존 담당 작업 스코프를 유지한다.
 * 실행: node tests/workdeskCellEditScope.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routes = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');

function routeBody(method, routePath) {
  const start = routes.indexOf(`router.${method}('${routePath}'`);
  assert.ok(start >= 0, `${routePath} 라우트가 있어야 합니다.`);
  const end = routes.indexOf('\nrouter.', start + 1);
  return routes.slice(start, end < 0 ? routes.length : end);
}

function functionBody(name) {
  const start = routes.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} 함수가 있어야 합니다.`);
  const end = routes.indexOf('\n}\n', start);
  return routes.slice(start, end + 2);
}

const cellScope = functionBody('_ensureWorkdeskCellEditScope');
assert.match(cellScope, /role === 'master'/, 'master는 셀 편집 가능해야 합니다.');
assert.match(cellScope, /role === 'admin'/, 'admin은 셀 편집 가능해야 합니다.');
assert.match(cellScope, /role === 'staff'/, 'staff는 모든 작업표를 셀 편집할 수 있어야 합니다.');
assert.doesNotMatch(cellScope, /canAccessTab/, '셀 편집 가드에서 담당 작업 검사를 하면 안 됩니다.');
assert.match(cellScope, /return \{ ok: false, code: 403/, '광고주를 포함한 외부 역할은 셀 편집에서 계속 차단되어야 합니다.');

for (const [method, routePath] of [['post', '/workdesk/edit'], ['post', '/workdesk/revert']]) {
  const body = routeBody(method, routePath);
  assert.match(body, /_ensureWorkdeskCellEditScope\(req\)/, `${routePath}는 직원 전체용 셀 편집 가드를 써야 합니다.`);
  assert.doesNotMatch(body, /_ensureEditScope\(req, sheetId, tabName\)/, `${routePath}에 담당 작업 스코프가 남으면 안 됩니다.`);
}

const tabsRoute = routeBody('get', '/tabs');
assert.match(tabsRoute, /allStaff: role === 'staff'/, '직원은 작업보드 목록에서 모든 작업을 받아야 합니다.');

const workdeskRoute = routeBody('get', '/workdesk');
assert.match(workdeskRoute, /allowAllStaff: role === 'staff'/, '직원은 담당 밖 작업표도 열 수 있어야 합니다.');

assert.match(service, /allStaff = false/, '목록 전체 공개는 작업보드 요청에서만 명시적으로 켜야 합니다.');
assert.match(service, /allowAllStaff = false/, '작업표 열람 전체 공개는 작업보드 요청에서만 명시적으로 켜야 합니다.');
assert.match(service, /role === 'staff' && !allowAllStaff/, '직원 담당 작업 제한은 전체 열람 플래그가 없을 때 유지해야 합니다.');

const sharedScope = functionBody('_ensureEditScope');
assert.match(sharedScope, /canAccessTab/, '마감·정산 등 공용 작업은 기존 담당 작업 스코프를 유지해야 합니다.');

console.log('✓ 직원 전체 작업표 셀 편집/붙여넣기 권한 및 공용 스코프 분리 확인');
