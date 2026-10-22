const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failed = 0;
function ok(label, condition) {
  if (condition) console.log('OK  ' + label);
  else { console.error('FAIL ' + label); failed++; }
}

// 옛 관리자 대시보드 폐기(결정 267) — 열 너비를 쓰던 화면(index-app.js)이 없어졌고,
// 서버 경로 GET/PUT /api/admin/my-workboard-preferences 도 결정 270(2026-10-22)으로 지웠다(작업보드는 이 경로를 부르지 않는다).
// ★ 저장돼 있던 표(admin_workboard_preferences, migration 151)는 지우지 않는다 — 스키마 변경 0. 그 사실과 경로 부재를 고정한다.
const migration = read('migrations/151_admin_workboard_preferences.sql');
const routes = read('src/routes/admin.routes.js');

ok('사용자별 설정 표 마이그레이션은 그대로 남아 있다(데이터·스키마 무접촉)',
  /CREATE TABLE IF NOT EXISTS admin_workboard_preferences/i.test(migration) &&
  /login_name TEXT PRIMARY KEY/i.test(migration) && /column_widths JSONB/i.test(migration));
ok('옛 대시보드 열 너비 조회·저장 경로는 제거 상태',
  !/router\.(get|put)\('\/my-workboard-preferences'/.test(routes) && !/admin_workboard_preferences/.test(routes));
ok('화면 어디에서도 그 경로를 부르지 않는다',
  !/my-workboard-preferences/.test(read('../frontend/workdesk.html')) && !/my-workboard-preferences/.test(read('../frontend/api.js')));

if (failed) process.exit(1);
