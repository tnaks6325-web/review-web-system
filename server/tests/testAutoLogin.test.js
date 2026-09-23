/**
 * Test deployment may opt into a direct-entry session, but production must
 * keep the endpoint unavailable. Run: node tests/testAutoLogin.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'src/routes/admin.routes.js'), 'utf8');
const cors = fs.readFileSync(path.join(root, 'src/middleware/cors.middleware.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');

assert.match(route, /router\.post\('\/test-auto-login'/, 'test-only auto-login route is defined');
assert.match(route, /process\.env\.TEST_AUTO_LOGIN\s*!==\s*'1'/, 'route is explicitly feature-flagged');
assert.match(route, /origin !== TEST_AUTO_LOGIN_ORIGIN[\s\S]{0,100}TEST_PR_FRONTEND_ORIGIN\.test/, 'route only accepts dedicated test frontend origins');
assert.match(route, /loginAdmin\(process\.env\.MASTER_ADMIN_NAME,\s*process\.env\.MASTER_ADMIN_PW\)/, 'credentials remain server-side');
assert.match(route, /status\(404\)/, 'disabled or foreign-origin requests are indistinguishable from absent route');
assert.match(cors, /TEST_AUTO_LOGIN_ORIGIN/, 'the test frontend is allowed through CORS only when test auto-login is enabled');
assert.match(cors, /process\.env\.TEST_AUTO_LOGIN === '1'[\s\S]{0,120}TEST_PR_FRONTEND_ORIGIN\.test/, 'PR frontend CORS is allowed only for test deployments');

assert.match(workdesk, /TEST_AUTO_LOGIN_HOST\s*=\s*'test-review-wdb-web-production\.up\.railway\.app'/, 'only the test frontend activates direct entry');
assert.match(workdesk, /window\.REVIEW_API_URL\s*=\s*TEST_AUTO_LOGIN_API/, 'test frontend also supplies its API base to api.js modules');
assert.match(workdesk, /\/api\/admin\/test-auto-login/, 'test frontend requests the dedicated endpoint');
assert.match(workdesk, /sessionStorage\.setItem\('admin_token',\s*result\.token\)/, 'issued token is stored in the existing session location');
assert.match(workdesk, /if\s*\(await tryTestAutoLogin\(\)\)\s*return boot\(\)/, 'boot retries after automatic session creation');

console.log('testAutoLogin: passed');
