/**
 * Approved work-order workspace parity contract.
 *
 * The live received-order screen must render the approved queue / source
 * detail / intake-decision workspace, while retaining the existing handlers.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-app.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');
const reference = path.join(root, 'frontend', 'mockups', 'work-order-unification-wireframe.html');

assert.ok(fs.existsSync(reference), 'The approved work-order reference must be versioned with the runtime.');
assert.match(app, /wo-runtime-workspace/);
assert.match(app, /grid-template-columns:232px minmax\(0,1fr\) 276px/);
assert.match(app, /wo-runtime-workspace__queue/);
assert.match(app, /wo-runtime-workspace__detail/);
assert.match(app, /wo-runtime-workspace__actions/);
assert.match(app, /function _renderWorkOrderWorkspaceDetail\(/);
assert.match(app, /function _renderWorkOrderWorkspaceActions\(/);
assert.match(app, /intranet_advertiser_id/);
assert.match(app, /intranet_advertiser_name/);
assert.match(app, /skip_weekends/);
assert.match(app, /courier_proxy/);
assert.match(app, /woAccept\('/);
assert.match(app, /woCreateCampaignGuarded\('/);
assert.match(app, /woAdminEdit\('/);
assert.doesNotMatch(app, /onclick="woRuntimeSelect/);

// The signed-in Track B workspace uses workdesk.html, not the legacy
// admin dashboard renderer.  The approved layout must be wired here too.
assert.match(workdesk, /function _renderWoParityBody\(/);
assert.match(workdesk, /wo-parity-workspace/);
assert.match(workdesk, /grid-template-columns:232px minmax\(0,1fr\) 276px/);
assert.match(workdesk, /function _woSelect\(i\)/);
assert.match(workdesk, /intranet_advertiser_id/);
assert.match(workdesk, /source_review_order_id/);
assert.match(workdesk, /skip_weekends/);
assert.match(workdesk, /_woAccept\('/);
assert.match(workdesk, /_woCampaign\('/);
assert.match(workdesk, /_woAdminEdit\('/);

console.log('workOrderCompactParity: passed');
