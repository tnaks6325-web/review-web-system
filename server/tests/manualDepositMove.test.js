'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const repair = fs.readFileSync(path.join(root, 'src/services/manualDepositRepair.service.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');

assert.match(repair, /async function moveDepositDateBetweenRows/, 'manual correction service must support a guarded date move');
assert.match(repair, /FOR UPDATE/, 'source and destination participants must be locked before a move');
assert.match(repair, /removeDepositStamp/, 'the move must remove only the requested source date');
assert.match(repair, /target_not_blank/, 'a populated destination must fail closed');
assert.match(repair, /rebuildLedgers\(/, 'sheetless workboard ledgers are rebuilt after the move');
assert.match(routes, /payment\/repair\/move-deposit-date', authMiddleware, adminOrMasterMiddleware/, 'manual move endpoint must be admin protected');
assert.match(routes, /sourceSeqs/, 'route receives visible workboard row numbers instead of opaque client ids');
assert.match(workdesk, /_pmOpenDepositDateCorrection/, 'payment UI exposes the controlled correction action');

console.log('manual deposit date move contract passed');
