/**
 * 작업보드 제목 편집 — 탭 식별키(tab_name)를 바꾸지 않고 display_name만 바꾼다.
 * 실행: node tests/workdeskTitleEdit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');

const ROOT = path.join(__dirname, '..', '..');
const routes = fs.readFileSync(path.join(ROOT, 'server/src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');

function routeBody(routePath) {
  const start = routes.indexOf(`router.post('${routePath}'`);
  assert.ok(start >= 0, `${routePath} 라우트가 있어야 합니다.`);
  const end = routes.indexOf('\nrouter.', start + 1);
  return routes.slice(start, end < 0 ? routes.length : end);
}

(async () => {
  const calls = [];
  svc.__setPoolForTest({
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ displayName: params[2] }], rowCount: 1 };
    },
  });

  try {
    const out = await svc.setWorkdeskTitle({ sheetId: 'S1', tabName: '원본 탭명', displayName: '  새 작업명  ', by: '만두' });
    assert.deepStrictEqual(out, { ok: true, displayName: '새 작업명' }, '공백을 정리한 표시명을 돌려줘야 합니다.');
    assert.match(calls[0].sql, /INSERT\s+INTO\s+tab_configs[\s\S]*display_name/i,
      '표시명은 tab_configs에 저장해야 합니다.');
    assert.match(calls[0].sql, /ON\s+CONFLICT\s*\(sheet_id,\s*tab_name\)\s+DO\s+UPDATE\s+SET[\s\S]*display_name\s*=\s*EXCLUDED\.display_name/i,
      '탭 식별키가 아니라 display_name만 갱신해야 합니다.');
    assert.doesNotMatch(calls[0].sql, /SET\s+tab_name\s*=/i, 'tab_name 변경은 연결 데이터를 끊으므로 금지합니다.');
    assert.deepStrictEqual(calls[0].params, ['S1', '원본 탭명', '새 작업명'], 'SQL 값은 매개변수로 전달해야 합니다.');
    await assert.rejects(
      () => svc.setWorkdeskTitle({ sheetId: 'S1', tabName: 'T1', displayName: '   ' }),
      /작업명/, '빈 작업명은 저장하면 안 됩니다.'
    );
  } finally {
    svc.__setPoolForTest(null);
  }

  const titleRoute = routeBody('/workdesk/title');
  assert.match(titleRoute, /const title = String\(displayName == null \? '' : displayName\)\.trim\(\);/,
    'HTTP 경계에서 작업명을 문자열·공백 제거로 정규화해야 합니다.');
  assert.match(titleRoute, /if \(!title \|\| title\.length > 120\) return res\.status\(400\)/,
    '빈 값·과도하게 긴 작업명은 DB 전에 차단해야 합니다.');
  assert.match(titleRoute, /_ensureWorkdeskCellEditScope\(req\)/,
    '내부 직원만 제목을 편집할 수 있어야 합니다.');
  assert.match(titleRoute, /svc\.setWorkdeskTitle\(/, '저장은 서비스 단일 경로를 써야 합니다.');
  assert.match(workdesk, /function editWorkdeskTitle\(/, '작업보드 제목 편집 함수가 있어야 합니다.');
  assert.match(workdesk, /\/api\/trackb\/workdesk\/title/, '제목 저장 API를 호출해야 합니다.');
  assert.match(workdesk, /m\.displayName\|\|STATE\.cur\.displayName\|\|STATE\.cur\.tabName/,
    '표시명이 있으면 작업보드 제목에 우선 표시해야 합니다.');

  console.log('✅ workdeskTitleEdit: 작업명 표시·저장·권한 회귀 가드 통과');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
