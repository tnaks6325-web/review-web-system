'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const frontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-payment.js'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'payment.routes.js'), 'utf8');

function functionSource(name) {
  const start = frontend.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  let depth = 0;
  let opened = false;
  for (let i = start; i < frontend.length; i++) {
    if (frontend[i] === '{') { depth++; opened = true; }
    if (frontend[i] === '}' && opened && --depth === 0) return frontend.slice(start, i + 1);
  }
  throw new Error(name + ' is not complete');
}

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok ' + name); passed++; }
  catch (error) { console.error('  not ok ' + name + '\n    ' + error.message); process.exitCode = 1; }
}

test('payment target API includes the configured manager', () => {
  assert.match(route, /tc\.manager\s+AS\s+"manager"/);
});

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(functionSource('paymentWorkKey') + '\n' + functionSource('filterPaymentTargets') + '\n' + functionSource('sumPaymentAmounts'), sandbox);

const targets = [
  { sheetId: 'S1', tabName: 'T1', manager: '만두', amount: '1,000' },
  { sheetId: 'S1', tabName: 'T2', manager: '망고', amount: '2,500원' },
  { sheetId: 'S2', tabName: 'T1', manager: '만두', amount: '300' },
];

test('filters payment targets by manager and exact work key together', () => {
  const rows = sandbox.filterPaymentTargets(targets, { manager: '만두', workKey: 'S2||T1' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), [targets[2]]);
});

test('sums only the rows selected for download', () => {
  assert.strictEqual(sandbox.sumPaymentAmounts([targets[0], targets[2]]), 1300);
});

if (!process.exitCode) console.log('\n' + passed + ' payment manager/work filter checks passed');
