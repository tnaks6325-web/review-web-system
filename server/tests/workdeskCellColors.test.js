/*
 * Workdesk cell background colors must only be reported as saved when every
 * requested cell was committed. Run: node tests/workdeskCellColors.test.js
 */
const assert = require('assert');
const { setCellColors, __setPoolForTest } = require('../src/services/trackB.service');

async function run() {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM campaign_participants')) {
        return { rows: [{ id: 'row-1', source: 'manual', order_submission_id: null }] };
      }
      if (sql.includes('INSERT INTO trackb_cell_colors')) throw new Error('database unavailable');
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  __setPoolForTest({ async connect() { return client; } });

  try {
    const result = await setCellColors({
      sheetId: 'sheet-1', tabName: 'tab-1', color: '#fff3b0',
      cells: [{ rowId: 'row-1', field: 'col:메모' }],
    });

    assert.equal(result.ok, false,
      'A failed database write must not be acknowledged as a saved background color.');
    assert.equal(result.applied, 0);
    assert.equal(result.skipped, 1);
    assert.ok(calls.some(c => c.sql === 'ROLLBACK'), 'The row transaction is rolled back on failure.');
  } finally {
    __setPoolForTest(null);
  }
  console.log('✓ workdesk cell-color failures are not reported as saved');
}

run().catch(err => { console.error(err); process.exitCode = 1; });
