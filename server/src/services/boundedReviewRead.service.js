'use strict';
const pool = require('../db/pool');
let active = 0;

// This optional popup must not exhaust the shared DB or its temporary disk.
async function boundedReviewRead(read) {
  if (active >= 2) throw Object.assign(new Error('Review warning busy'), { code: 'REVIEW_WARNING_BUSY' });
  active++;
  let client, inTransaction = false, releaseError;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '1500ms'");
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL temp_file_limit = '64MB'");
    await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
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
