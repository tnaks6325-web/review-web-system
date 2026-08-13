const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
const campaignRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'campaign.routes.js'), 'utf8');
const entrypoint = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

assert.match(
  app,
  /const readOnlyPreview = process\.env\.READ_ONLY_MODE === 'true';/,
  'READ_ONLY_MODE must enable the server-side preview guard'
);
assert.match(
  app,
  /if \(\['GET', 'HEAD', 'OPTIONS'\]\.includes\(req\.method\)\) return next\(\);/,
  'read-only preview must allow only safe HTTP methods by default'
);
assert.match(
  app,
  /req\.path === '\/auth\/login'/,
  'read-only preview must preserve the login endpoint'
);
assert.match(
  app,
  /읽기 전용 프리뷰에서는 저장할 수 없습니다/,
  'blocked requests must receive a safe user-facing error'
);
assert.match(
  campaignRoute,
  /async function _ensureTables\(\) \{[\s\S]{0,260}?if \(process\.env\.READ_ONLY_MODE === 'true'\) return;/,
  'campaign GET routes must not attempt schema creation when connected with a read-only role'
);

assert.match(
  entrypoint,
  /const readOnlyPreview = process\.env\.READ_ONLY_MODE === 'true';/,
  'entrypoint must identify the read-only preview before starting jobs'
);
assert.match(
  entrypoint,
  /if \(!readOnlyPreview\) \{\s*try \{\s*await runMigrations\(\);/,
  'read-only preview must not run migrations against the production database'
);
assert.match(
  entrypoint,
  /process\.env\.NODE_ENV === 'production' && !readOnlyPreview/,
  'read-only preview must not start production jobs that could write or sync external services'
);

console.log('readOnlyPreviewGuard: passed');
