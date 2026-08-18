const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/workdesk.html'), 'utf8');
const body = (src.match(/router\.post\('\/campaigns\/release-today-unsubmitted-holds'[\s\S]*?\n\}\);/) || [''])[0];

assert.match(body, /const campaignId = String\(req\.body\?\.campaignId \|\| ''\)\.trim\(\)/, 'reads the selected campaign ID explicitly');
assert.match(body, /SELECT id, title\s+FROM recruit_campaigns\s+WHERE id = \$1 AND status = 'active'/, 're-checks that the selected campaign is active server-side');
assert.match(body, /campaign_id = \$1/, 'updates only the selected campaign');
assert.doesNotMatch(body, /const campaignIds = \[/, 'does not depend on a hard-coded campaign list');
assert.match(body, /status = 'applied'/, 'releases pending holds only');
assert.doesNotMatch(body, /status = 'submitted'/, 'never releases submitted applications');
assert.match(body, /applied_at >= date_trunc\('day', NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)/, 'limits release to today in KST');
assert.match(body, /confirm !== 'release-today-unsubmitted-holds'/, 'requires an explicit confirmation token');
assert.match(body, /logger\.info\(/, 'writes an audit log with the operator, campaign, and release count');
assert.match(workdesk, /api\('\/api\/trackb\/campaigns\/list'\)/, 'loads the live campaign list before opening the picker');
assert.match(workdesk, /campaignId:selected\.id/, 'sends only the selected campaign ID to the release endpoint');
assert.match(workdesk, /co-release-search/, 'provides a searchable campaign picker UI');
assert.match(workdesk, /test-review-wdb-web-review-web-system-pr-\(\\d\+\)/, 'PR workdesk routes API calls to its matching PR API instead of production');
console.log('today unsubmitted hold release is safely scoped');
