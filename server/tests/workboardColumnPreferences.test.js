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
const client = read('../frontend/js/index-app.js');

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
ok('클라이언트는 서버값을 우선하고 오프라인에서는 기존 로컬값으로 폴백한다',
  /function _savedColWidths\(\)/.test(client) &&
  /_serverColWidths === null \? _readLocalColWidths\(\) : _serverColWidths/.test(client));
ok('드래그 저장과 초기화 모두 서버에 반영한다',
  /void _saveServerColWidths\(data\)/.test(client) &&
  /void _saveServerColWidths\(\{\}\)/.test(client));
ok('대시보드 첫 렌더링 전 서버 설정을 불러온다',
  /_loadServerColWidths\(\)\.finally\(\(\) => loadAdminDashboard\(\)\)/.test(client));

if (failed) process.exit(1);
