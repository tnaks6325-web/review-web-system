'use strict';

// 8/11 수동 이체 #0 회차 복구 도구는 운영에서 실행 완료(payment_batches.historical_key='manual-811', 339건)
// → 결정 186 59번에서 버튼·라우트·서비스를 제거했다. 남는 계약: #0 회차 저장소(마이그레이션 117)와
// 장부 재생성마다 수동 입금 표기를 되살리는 rehydrate. 복구 도구가 되살아나지 않는지도 본다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const repair = fs.readFileSync(path.join(root, 'src/services/manualDepositRepair.service.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations/117_manual_811_transfer_ledger.sql'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'src/services/sheetlessLedger.service.js'), 'utf8');

assert.doesNotMatch(routes, /router\.(get|post)\('\/payment\/repair\/manual-811/, '실행 완료된 8/11 복구 입구가 되살아났다(다시 누르면 339줄에 재기록)');
assert.doesNotMatch(workdesk, /_pmRestoreManual811/, '입금관리에 8/11 복구 버튼이 되살아났다');
assert.doesNotMatch(repair, /function restoreManual811DepositDates|function previewManual811Transfer/, '8/11 복구 서비스가 되살아났다');
assert.match(repair, /historical_key = 'manual-811'/, '번진 입금일 정리는 #0 수동 이력 회차를 계속 식별한다');
assert.match(migration, /historical_key/, 'only one #0 historical batch can exist');
assert.match(migration, /manual_payment_marks/, 'migration creates durable manual payment marker storage');
assert.match(ledger, /rehydrateManualPaymentMarks/, 'every sheetless ledger rebuild restores permanent manual payment marks first');

console.log('manual 8/11 deposit repair retirement contract passed');
