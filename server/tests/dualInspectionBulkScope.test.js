'use strict';
// Whole-tab bulk resolution must lock the scope of every file it can close, not a caller-chosen subset.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('bulk resolution discovers lifecycle scope from the whole tab even if fileIds is supplied', async () => {
  const poolPath = require.resolve('../src/db/pool');
  const queries = [];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (/SELECT file_id FROM review_submissions WHERE sheet_id=\$1 AND tab_name=\$2/.test(sql)) return { rows: [{ file_id: 'A' }, { file_id: 'B' }, { file_id: 'C' }] };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  } };
  const reviewPath = require.resolve('../src/services/dualChannelReview.service');
  const seen = [];
  require.cache[reviewPath] = { id: reviewPath, filename: reviewPath, loaded: true, exports: {
    withReviewFilesMutation: async ({ fileIds, run }) => { seen.push(fileIds); return run(null, { dual: false }); },
  } };
  try {
    const RI = require('../src/services/reviewInspect.service');
    const out = await RI.resolveInspectionsBulk({ sheetId: 'S', tabName: 'T', resolution: 'ok', by: 'tester', fileIds: ['A'] });
    assert.equal(out.ok, true);
    assert.deepEqual(seen, [['A', 'B', 'C']], 'scope covers every file the whole-tab UPDATE can close');
    const upd = queries.find(q => /UPDATE review_inspections/.test(q.sql));
    assert.ok(upd && /i\.sheet_id = \$1 AND i\.tab_name = \$2/.test(upd.sql), 'mutation range is still the whole tab');
  } finally {
    delete require.cache[poolPath]; delete require.cache[reviewPath];
    delete require.cache[require.resolve('../src/services/reviewInspect.service')];
  }
});
