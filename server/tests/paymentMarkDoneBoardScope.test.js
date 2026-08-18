'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/payment.routes.js'), 'utf8');

assert.match(source, /recordDeposits\(client, items, \{ by: req\.admin\?\.name \|\| '' \}\)/,
  'mark-done은 서버 DB 입금 원장을 통해서만 처리해야 한다');
assert.doesNotMatch(source, /markDepositCells\(/,
  'mark-done은 구글시트·입금일 후처리를 호출하면 안 된다');
assert.doesNotMatch(source, /nowStamp\(/,
  '구글시트 입금일 표기를 만들면 안 된다');
console.log('payment mark-done DB-only tests passed');
