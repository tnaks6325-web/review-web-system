'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const repair = fs.readFileSync(path.join(root, 'src/services/manualDepositRepair.service.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations/117_manual_811_transfer_ledger.sql'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'src/services/sheetlessLedger.service.js'), 'utf8');

assert.match(repair, /btrim\(pe\.value_text\) = '8\/11'/, 'repair scope must be fixed to the historical 8/11 marker');
assert.match(repair, /pe\.reverted_at IS NULL/, 'only the administrator\'s final active manual mark may be restored');
assert.match(repair, /markDepositCells\(items, \{ by, deferSheetlessRebuild: true \}\)/, 'repair writes through the shared board path but rebuilds a tab once');
assert.match(repair, /rebuildLedgers\(/, 'sheetless workboard ledgers are rebuilt after the repair');
assert.match(repair, /stamp: '8\/11'/, 'repair must write the original historical payment date');
assert.match(routes, /payment\/repair\/manual-811-deposit-dates', authMiddleware, adminOrMasterMiddleware/, 'repair endpoint must be admin protected');
assert.match(routes, /need_confirm/, 'repair endpoint requires an explicit confirmation');
assert.match(workdesk, /_pmRestoreManual811/, 'payment UI exposes the repair action');
assert.match(repair, /seq, bank, status, item_count, total_amount/, 'recovery creates an auditable transfer batch');
assert.match(repair, /VALUES \(0, 'manual', 'applied'/, 'historical batch is always #0 and applied');
assert.match(repair, /manual_payment_marks/, 'persistent marker is recorded beside the batch');
assert.match(repair, /payment_records[\s\S]*source_key/, 'payment ledger has an idempotent source key');
assert.match(repair, /board_recorded_count[\s\S]*board_stamp = '8\/11'/, 'batch table records the real workboard write outcome');
assert.match(repair, /already_locked/, 'existing active transfer items stop a duplicate recovery');
assert.match(migration, /historical_key/, 'only one #0 historical batch can exist');
assert.match(migration, /manual_payment_marks/, 'migration creates durable manual payment marker storage');
assert.match(ledger, /rehydrateManualPaymentMarks/, 'every sheetless ledger rebuild restores permanent manual payment marks first');

console.log('manual 8/11 deposit repair contract passed');
