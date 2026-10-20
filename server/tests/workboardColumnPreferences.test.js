const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failed = 0;
function ok(label, condition) {
  if (condition) console.log('OK  ' + label);
  else { console.error('FAIL ' + label); failed++; }
}

const migration = read('migrations/151_admin_workboard_preferences.sql');
const routes = read('src/routes/admin.routes.js');

ok('사용자별 설정 테이블과 JSONB 폭 저장소를 만든다',
  /CREATE TABLE IF NOT EXISTS admin_workboard_preferences/i.test(migration) &&
  /login_name TEXT PRIMARY KEY/i.test(migration) && /column_widths JSONB/i.test(migration));
ok('조회·저장은 로그인 JWT를 요구한다',
  /router\.get\('\/my-workboard-preferences', authMiddleware/.test(routes) &&
  /router\.put\('\/my-workboard-preferences', authMiddleware/.test(routes));
ok('저장은 로그인명 기준 upsert이며 클라이언트 계정명을 받지 않는다',
  /ON CONFLICT \(login_name\) DO UPDATE/.test(routes) &&
  /\[loginName, JSON\.stringify\(columnWidths\)\]/.test(routes) &&
  !/req\.body[^\n]*loginName/.test(routes));
ok('너비 키·최소값·상한을 서버에서 검증한다',
  /WORKBOARD_COLUMN_MIN_WIDTHS/.test(routes) && /formlink: 28/.test(routes) &&
  /income: 60/.test(routes) && /depositname: 80/.test(routes) &&
  /rounded >= minWidth && rounded <= 2000/.test(routes));
// 옛 관리자 대시보드 폐기(결정 267) — 열 너비를 쓰던 화면(index-app.js)이 없어져 클라이언트 검사는 뺐다.
//   서버 경로(/api/admin/my-workboard-preferences)는 이번 폐기에서 남겨 두므로(서버 정리는 별도 단계) 위 서버 검사는 유지한다.

if (failed) process.exit(1);
