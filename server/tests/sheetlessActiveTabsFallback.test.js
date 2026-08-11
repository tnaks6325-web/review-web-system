/**
 * 전환된 작업표는 마지막 시트 미러·index_master 상태가 없어도 작업목록에 남아야 한다.
 * 실행: node tests/sheetlessActiveTabsFallback.test.js
 */
const assert = require('assert');
const participants = require('../src/services/participants.service');

(async () => {
  let sql = '';
  participants.__setPoolForTest({
    query: async (query) => {
      sql = String(query);
      return { rows: [] };
    },
  });

  try {
    await participants.listActiveTabs({ limit: 10 });
  } finally {
    participants.__setPoolForTest(null);
  }

  assert.match(sql, /sheetless_tabs\s+AS/i,
    '전환 작업표를 위한 독립 목록 CTE가 없다');
  assert.match(sql, /FROM\s+tab_configs\s+tc/i,
    '전환 작업표의 등록 원본(tab_configs)을 읽지 않는다');
  assert.match(sql, /COALESCE\(tc\.sheetless,\s*FALSE\)\s*=\s*TRUE/i,
    'sheetless=true인 전환 작업만 보충해야 한다');
  assert.match(sql, /COALESCE\(tc\.is_closed,\s*FALSE\)\s*=\s*FALSE/i,
    '마감된 전환 작업이 작업목록에 되살아날 수 있다');
  assert.match(sql, /UNION ALL/i,
    '기존 시트 기반 목록과 전환 작업표 목록을 합치지 않는다');

  console.log('✅ sheetlessActiveTabsFallback: 전환 작업표 목록 보충 회귀 가드 통과');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
