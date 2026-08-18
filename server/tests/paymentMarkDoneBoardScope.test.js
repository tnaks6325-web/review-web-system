'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/payment.routes.js'), 'utf8');

assert.match(source, /const recordedItems = \[\];/,
  'mark-done은 실제로 새 입금 처리된 행을 따로 수집해야 한다');
assert.match(source, /recordDeposits\(client, items, \{ by: req\.admin\?\.name \|\| '', appliedItems: recordedItems \}\)/,
  '공통 입금 기록 경로가 새 처리 행만 반환해야 한다');
assert.match(source, /markDepositCells\(recordedItems, \{ stamp, by: req\.admin\?\.name \|\| 'payment' \}\)/,
  '작업보드에는 새 처리 행만 기록해야 한다');
console.log('payment mark-done board scope tests passed');
