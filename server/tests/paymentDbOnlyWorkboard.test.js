'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apply = fs.readFileSync(path.join(root, 'src/services/paymentApply.service.js'), 'utf8');
const queue = fs.readFileSync(path.join(root, 'src/services/syncQueue.service.js'), 'utf8');
const paymentRoute = fs.readFileSync(path.join(root, 'src/routes/payment.routes.js'), 'utf8');
const depositCase = queue.slice(queue.indexOf("case 'deposit_mark':"), queue.indexOf("case 'order_append':"));

assert.doesNotMatch(apply, /require\('\.\/sheets\.service'\)/,
  '입금 처리 서비스는 구글시트 쓰기 서비스를 불러오면 안 된다');
assert.doesNotMatch(apply, /enqueue\('deposit_mark'/,
  '새 입금 처리에서 구글시트 기록 큐를 만들면 안 된다');
assert.doesNotMatch(depositCase, /readSheet\(|writeSheet\(/,
  '기존 deposit_mark 큐도 구글시트에 쓰지 않고 종료해야 한다');
assert.doesNotMatch(paymentRoute, /markDepositCells\(/,
  '수동 입금 완료는 DB 원장만 기록하고 별도 시트 기록을 호출하면 안 된다');
console.log('payment DB-only workboard tests passed');
