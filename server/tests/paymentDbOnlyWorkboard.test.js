'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apply = fs.readFileSync(path.join(root, 'src/services/paymentApply.service.js'), 'utf8');
const queue = fs.readFileSync(path.join(root, 'src/services/syncQueue.service.js'), 'utf8');
const depositCase = queue.slice(queue.indexOf("case 'deposit_mark':"), queue.indexOf("case 'order_append':"));

assert.doesNotMatch(apply, /require\('\.\/sheets\.service'\)/,
  '입금 처리 서비스는 구글시트 쓰기 서비스를 불러오면 안 된다');
assert.doesNotMatch(apply, /enqueue\('deposit_mark'/,
  '새 입금 처리에서 구글시트 기록 큐를 만들면 안 된다');
assert.doesNotMatch(depositCase, /readSheet\(|writeSheet\(/,
  '기존 deposit_mark 큐도 구글시트에 쓰지 않고 종료해야 한다');
assert.ok(!fs.existsSync(path.join(root, 'src/routes/payment.routes.js')),
  '옛 입금처리 옆길(/api/payment — 회차를 건너뛰는 수동 이체완료)은 결정 186 57번에서 제거 — 되살리지 않는다');
console.log('payment DB-only workboard tests passed');
