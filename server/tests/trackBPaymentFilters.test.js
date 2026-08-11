'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const paymentService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'payment.service.js'), 'utf8');

function sourceOf(name) {
  const start = workdesk.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = start; i < workdesk.length; i++) {
    if (workdesk[i] === '{') { depth++; started = true; }
    else if (workdesk[i] === '}' && started && --depth === 0) return workdesk.slice(start, i + 1);
  }
  throw new Error(name + ' is incomplete');
}

function test(name, fn) {
  try { fn(); console.log('  ok ' + name); }
  catch (error) { console.error('  not ok ' + name + '\n    ' + error.message); process.exitCode = 1; }
}

test('payment target metadata includes the work manager', () => {
  assert.match(paymentService, /tc\.manager\s+AS\s+"manager"/);
  assert.match(paymentService, /manager:\s*t\.manager\s*\|\|\s*''/);
});

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(sourceOf('_pmWorkKey') + '\n' + sourceOf('_pmManagerName') + '\n' + sourceOf('_pmFilterItems') + '\n' + sourceOf('_pmSelectedPaymentTotal') + '\n' + sourceOf('_pmToggleWorkKeys'), sandbox);

test('legacy manager name is normalized to mango', () => {
  assert.strictEqual(sandbox._pmManagerName('\uBC15\uC740\uBE44'), '\uB9DD\uACE0');
});

const rows = [
  { sheetId: 'S1', tabName: 'A', manager: '\uB9CC\uB450', amount: 1000, payable: true, excluded: false },
  { sheetId: 'S1', tabName: 'B', manager: '\uB9DD\uACE0', amount: 2200, payable: true, excluded: false },
  { sheetId: 'S2', tabName: 'A', manager: '\uB9CC\uB450', amount: 300, payable: true, excluded: true },
  { sheetId: 'S3', tabName: 'C', manager: '\uB9CC\uB450', amount: 700, payable: true, excluded: false },
];

test('manager and multiple selected works narrow the download candidates together', () => {
  const out = sandbox._pmFilterItems(rows, { manager: '\uB9CC\uB450', workKeys: ['S1||A', 'S3||C'] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), [rows[0], rows[3]]);
});

test('download total excludes unchecked rows within the active filters', () => {
  assert.strictEqual(sandbox._pmSelectedPaymentTotal(rows, { manager: '\uB9CC\uB450', workKeys: ['S1||A', 'S2||A'] }), 1000);
});

test('an empty selected-work list produces no download candidates', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmFilterItems(rows, { manager: '\uB9CC\uB450', workKeys: [] }))), []);
});

test('toggling work rows preserves every other selected work', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmToggleWorkKeys(['S1||A', 'S3||C'], ['S1||A', 'S2||A', 'S3||C'], 'S2||A'))), ['S1||A', 'S2||A', 'S3||C']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmToggleWorkKeys(['S1||A', 'S2||A'], ['S1||A', 'S2||A'], 'S1||A'))), ['S2||A']);
});
