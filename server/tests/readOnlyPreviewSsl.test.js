const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pool = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'pool.js'), 'utf8');

assert.match(
  pool,
  /const allowSelfSignedDatabaseCert = process\.env\.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false';/,
  'only an explicit database-scoped flag may relax certificate validation'
);
assert.match(
  pool,
  /const databaseUrlRequestsSsl = \/sslmode=require\/.test\(connectionString \|\| ''\);/,
  'a Railway public URL requesting SSL must configure the pg SSL client'
);
assert.match(
  pool,
  /if \(\(isProduction \|\| databaseUrlRequestsSsl \|\| allowSelfSignedDatabaseCert\) && connectionString\) \{\s*poolConfig\.ssl = \{ rejectUnauthorized: !allowSelfSignedDatabaseCert \};/,
  'the explicit flag must only affect the pg database client'
);
assert.ok(!pool.includes('NODE_TLS_REJECT_UNAUTHORIZED'), 'global TLS verification must never be disabled');

console.log('readOnlyPreviewSsl: passed');
