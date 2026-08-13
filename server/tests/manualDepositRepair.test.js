'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const repair = fs.readFileSync(path.join(root, 'src/services/manualDepositRepair.service.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');

assert.match(repair, /btrim\(pe\.value_text\) = '8\/11'/, 'repair scope must be fixed to the historical 8/11 marker');
assert.doesNotMatch(repair, /pe\.reverted_at IS NULL/, 'reverted markers are the affected records and must not be omitted');
assert.match(repair, /markDepositCells\(items, \{ by, deferSheetlessRebuild: true \}\)/, 'repair writes through the shared board path but rebuilds a tab once');
assert.match(repair, /rebuildLedgers\(/, 'sheetless workboard ledgers are rebuilt after the repair');
assert.match(repair, /stamp: '8\/11'/, 'repair must write the original historical payment date');
assert.match(routes, /payment\/repair\/manual-811-deposit-dates', authMiddleware, adminOrMasterMiddleware/, 'repair endpoint must be admin protected');
assert.match(routes, /need_confirm/, 'repair endpoint requires an explicit confirmation');
assert.match(workdesk, /_pmRestoreManual811/, 'payment UI exposes the repair action');

console.log('manual 8/11 deposit repair contract passed');
