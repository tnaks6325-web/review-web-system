'use strict';
const pool = require('../db/pool');
let active = 0;

// Optional warning/earnings reads must not exhaust the shared DB or its disk.
async function boundedReviewRead(read) {
  if (active >= 2) throw Object.assign(new Error('Review warning busy'), { code: 'REVIEW_WARNING_BUSY' });
  active++;
  let client, inTransaction = false, releaseError;
  try {
    client = await pool.connect();
    inTransaction = true;
    await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '1500ms'; SET LOCAL lock_timeout = '500ms'; SET LOCAL temp_file_limit = '64MB'; SET LOCAL max_parallel_workers_per_gather = 0");
    const result = await read(client);
    await client.query('COMMIT');
    inTransaction = false;
    return result;
  } finally {
    try {
      if (client) {
        if (inTransaction) {
          try { await client.query('ROLLBACK'); } catch (err) { releaseError = err; }
        }
        client.release(releaseError);
      }
    } finally { active--; }
  }
}
module.exports = { boundedReviewRead };
